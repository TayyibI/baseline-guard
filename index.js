const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const doiuse = require('doiuse');
const { glob } = require('glob');
const postcss = require('postcss');

// Inline toDate function
function toDate(dateString) {
    return new Date(dateString);
}

let features;
try {
    // CHANGE: Load the data.json file from the same directory as the script.
    // The build process now copies it to the 'dist' folder.
    const dataPath = path.join(__dirname, 'data.json');
    features = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    // DEBUGGING: Add this line to confirm the fix.
    core.info(`Successfully loaded web-features. Total features found: ${Object.keys(features).length}`);

} catch (error) {
    core.setFailed(`Failed to load web-features from ${path.join(__dirname, 'data.json')}: ${error.message}`);
    process.exit(1);
}


function generateReport(violations, targetBaseline) {
    let report = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Baseline Guard Report</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            table { border-collapse: collapse; width: 100%; margin-top: 20px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            h1 { color: #333; }
            p { margin: 10px 0; }
        </style>
    </head>
    <body>
        <h1>Baseline Guard Report</h1>
        <p><strong>Status:</strong> ${violations.length > 0 ? 'Failed' : 'Passed'}</p>
        <p><strong>Target Baseline:</strong> ${targetBaseline}</p>
        <p><strong>Violations Found:</strong> ${violations.length}</p>
    `;

    if (violations.length > 0) {
        report += `
        <h2>Violations</h2>
        <table>
            <tr>
                <th>File</th>
                <th>Line</th>
                <th>Column</th>
                <th>Feature</th>
                <th>Reason</th>
                <th>MDN Link</th>
            </tr>
        `;
        violations.forEach(v => {
            const featureData = features[v.feature] || {};
            const mdnLink = featureData.mdn_url || `https://developer.mozilla.org/en-US/search?q=${v.feature}`;
            report += `
            <tr>
                <td>${v.file}</td>
                <td>${v.line}</td>
                <td>${v.column}</td>
                <td>${v.feature}</td>
                <td>${v.reason}</td>
                <td><a href="${mdnLink}" target="_blank">MDN</a></td>
            </tr>
            `;
        });
        report += `</table>`;
    } else {
        report += `<p>All scanned features meet the ${targetBaseline} target criteria.</p>`;
    }

    report += `</body></html>`;
    return report;
}

function getCompliantFeatureIds(target, failOnNewly) {
    const compliantIds = new Set();
    const lowerTarget = target.toLowerCase();

    // Validate target-baseline
    if (!['widely', 'newly'].includes(lowerTarget) && isNaN(parseInt(lowerTarget))) {
        throw new Error(`Invalid target-baseline: ${target}. Must be 'widely', 'newly', or a year (e.g., '2023').`);
    }

    for (const [featureId, featureData] of Object.entries(features)) {
        const status = featureData.status?.baseline || '';
        const lowDate = featureData.status?.baseline_low_date || '';

        let isCompliant = false;
        
        // Determine initial compliance based on the target
        if (lowerTarget === 'widely') {
            if (status === 'high') {
                isCompliant = true;
            }
        } else if (lowerTarget === 'newly') {
            if (status === 'high' || status === 'low') {
                isCompliant = true;
            }
        } else {
            const targetYear = parseInt(lowerTarget, 10);
            if (!isNaN(targetYear) && lowDate && toDate(lowDate).getFullYear() <= targetYear) {
                isCompliant = true;
            }
        }

        // Now, apply the `fail-on-newly` override.
        // This will only set `isCompliant` to false if it was previously true for a 'low' status feature.
        if (failOnNewly && status === 'low') {
            isCompliant = false;
        }

        if (isCompliant) {
            compliantIds.add(featureId);
        }
    }

    if (compliantIds.size === 0) {
        core.warning(`No features found matching the "${target}" criteria. This might mean your target is too restrictive or the feature data is not as expected.`);
    } else {
        core.debug(`${compliantIds.size} compliant features found. Example: ${Array.from(compliantIds)[0]}`);
    }

    return compliantIds;
}

async function run() {
    try {
        const targetBaseline = core.getInput('target-baseline', { required: true });
        const scanFiles = core.getInput('scan-files', { required: true });
        const failOnNewly = core.getInput('fail-on-newly') === 'true';
        const reportArtifactName = core.getInput('report-artifact-name') || 'baseline-guard-report.html';

        core.info('--- Baseline Guard Configuration ---');
        core.info(`Target Baseline: ${targetBaseline}`);
        core.info(`Files to Scan: ${scanFiles}`);
        core.info(`Fail on Newly Available: ${failOnNewly}`);
        core.info(`Report Name: ${reportArtifactName}`);
        core.info('------------------------------------');

        const compliantFeatureIds = getCompliantFeatureIds(targetBaseline, failOnNewly);
        core.info(`Found ${compliantFeatureIds.size} features matching Baseline criteria.`);

        // The browserslist config for doiuse is "not supports <feature>", so we need the *inverse* set.
        const allFeatureIds = new Set(Object.keys(features));
        const nonCompliantFeatureIds = new Set([...allFeatureIds].filter(id => !compliantFeatureIds.has(id)));

        core.info(`Checking against ${nonCompliantFeatureIds.size} non-compliant features.`);

        const allViolations = [];
        const filePaths = await glob(scanFiles, { ignore: 'node_modules/**' });
        
        // <-- CHANGE: This is how you create and use a doiuse processor
        const doiusePlugin = doiuse({
            ignore: [], // You could add features to ignore here
            onFeatureUsage: function (usageInfo) {
                // We will check for compliance manually inside the loop
            }
        });
        const processor = postcss([doiusePlugin]);

        for (const filePath of filePaths) {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            if (filePath.endsWith('.css')) {
                try {
                    const result = await processor.process(fileContent, { from: filePath });
                    for (const message of result.messages) {
                        if (message.plugin === 'doiuse' && nonCompliantFeatureIds.has(message.feature)) {
                             allViolations.push({
                                file: filePath,
                                line: message.line || 'unknown',
                                column: message.column || 'unknown',
                                feature: message.feature,
                                reason: `CSS feature '${message.feature}' is not compliant with the '${targetBaseline}' Baseline target.`
                            });
                        }
                    }
                } catch (err) {
                    core.error(`Failed to process CSS file ${filePath}: ${err.message}`);
                }
            } else if (filePath.endsWith('.js')) {
                 // You can enhance JS scanning here. This is a placeholder.
                 // For now, we'll check against the non-compliant list.
                 nonCompliantFeatureIds.forEach(api => {
                    // This is a very basic check and can have false positives.
                    // A more robust solution would use an AST parser.
                    if (fileContent.includes(api)) {
                        allViolations.push({
                            file: filePath,
                            line: 'unknown',
                            column: 'unknown',
                            feature: api,
                            reason: `Potential usage of JS feature '${api}' which is not compliant with the '${targetBaseline}' Baseline target.`
                        });
                    }
                });
            }
        }

        if (allViolations.length > 0) {
            core.warning(`❌ Baseline Guard found ${allViolations.length} violations against the ${targetBaseline} target.`);
            const reportContent = generateReport(allViolations, targetBaseline);
            fs.writeFileSync(reportArtifactName, reportContent);

            core.startGroup('Violation Summary');
            allViolations.forEach(v => {
                core.error(`[${v.file}:${v.line}:${v.column}] ${v.reason}`);
            });
            core.endGroup();

            core.setOutput('violations-found', 'true');
            core.setFailed(`Build failed due to ${allViolations.length} Baseline violations.`);
        } else {
            core.info('✅ Baseline Guard passed! All scanned features meet the target criteria.');
            core.setOutput('violations-found', 'false');
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}\n${error.stack}`);
    }
}

run();