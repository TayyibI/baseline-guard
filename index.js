const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const doiuse = require('doiuse');
const { glob } = require('glob');

// Inline toDate function
function toDate(dateString) {
    return new Date(dateString);
}

let features;
try {
    const dataPath = require.resolve('web-features/data.json');
    features = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    core.debug('Loaded web-features: ' + JSON.stringify(Object.keys(features).slice(0, 5)));
    core.debug('Sample feature data: ' + JSON.stringify(features[Object.keys(features)[0]], null, 2));
} catch (error) {
    core.setFailed(`Failed to load web-features: ${error.message}`);
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
                <th>Feature</th>
                <th>Reason</th>
                <th>MDN Link</th>
            </tr>
        `;
        violations.forEach(v => {
            const featureData = features[v.feature] || {};
            const mdnLink = featureData.mdn_url || `https://developer.mozilla.org/en-US/docs/Web/${v.feature.includes('css') ? 'CSS' : 'API'}/${v.feature.replace(/-/g, '_')}`;
            report += `
            <tr>
                <td>${v.file}</td>
                <td>${v.line}</td>
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
    const allFeatures = Object.values(features);

    const lowerTarget = target.toLowerCase();

    // Validate target-baseline
    if (!['widely', 'newly'].includes(lowerTarget) && isNaN(parseInt(lowerTarget))) {
        throw new Error(`Invalid target-baseline: ${target}. Must be 'widely', 'newly', or a year (e.g., '2023').`);
    }

    for (const feature of allFeatures) {
        // Handle missing or malformed status data
        const status = feature.status?.baseline || '';
        const highDate = feature.baseline_high_date || '';
        const lowDate = feature.baseline_low_date || '';

        let isCompliant = false;

        if (lowerTarget === 'widely' && status === 'high') {
            isCompliant = true;
        } else if (lowerTarget === 'newly' && (status === 'high' || status === 'low')) {
            isCompliant = true;
        }

        if (failOnNewly && status === 'low') {
            isCompliant = false;
        }

        const targetYear = parseInt(lowerTarget, 10);
        if (!isNaN(targetYear)) {
            if (lowDate && toDate(lowDate).getFullYear() <= targetYear) {
                isCompliant = true;
            }
            if (highDate && toDate(highDate).getFullYear() <= targetYear) {
                isCompliant = true;
            }
        }

        if (isCompliant && feature.id) {
            compliantIds.add(feature.id);
            core.debug(`Compliant feature: ${feature.id}`);
        }
    }

    if (compliantIds.size === 0) {
        core.warning('No compliant features found. Check web-features data structure.');
    }

    return compliantIds;
}

async function run() {
    try {
        // 1. Read Inputs
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

        // 2. Get Compliant Features
        const compliantFeatureIds = getCompliantFeatureIds(targetBaseline, failOnNewly);
        core.info(`Found ${compliantFeatureIds.size} features matching Baseline criteria.`);

        // 3. Scan Files (CSS and JS)
        const allViolations = [];
        const filePaths = await glob(scanFiles, { ignore: 'node_modules/**' });

        for (const filePath of filePaths) {
            if (filePath.endsWith('.css')) {
                const cssContent = fs.readFileSync(filePath, 'utf-8');
                doiuse({
                    browsers: [],
                    onFeatureUsage: (usage) => {
                        const featureId = usage.feature;
                        if (!compliantFeatureIds.has(featureId)) {
                            allViolations.push({
                                file: filePath,
                                line: usage.line || 'unknown',
                                feature: featureId,
                                reason: `Not found in Baseline Target: ${targetBaseline}`
                            });
                        }
                    }
                })(cssContent, { from: filePath });
            } else if (filePath.endsWith('.js')) {
                const jsContent = fs.readFileSync(filePath, 'utf-8');
                const nonCompliantAPIs = ['fetch', 'Promise.any'];
                nonCompliantAPIs.forEach(api => {
                    if (jsContent.includes(api)) {
                        allViolations.push({
                            file: filePath,
                            line: 'unknown',
                            feature: api,
                            reason: `Non-compliant JS API for ${targetBaseline}`
                        });
                    }
                });
            }
        }

        // 4. CI Gate Logic
        if (allViolations.length > 0) {
            core.warning(`❌ Baseline Guard found ${allViolations.length} violations against the ${targetBaseline} target.`);

            // Generate and save report
            const reportPath = 'baseline-guard-report.html';
            const reportContent = generateReport(allViolations, targetBaseline);
            fs.writeFileSync(reportPath, reportContent);

            core.startGroup('Violation Summary');
            core.info('| File | Line | Feature | Reason |');
            core.info('|---|---|---|---|');
            allViolations.forEach(v => {
                core.info(`| ${v.file} | ${v.line} | ${v.feature} | ${v.reason} |`);
            });
            core.endGroup();

            allViolations.forEach(v => {
                core.error(`[VIOLATION] Feature "${v.feature}" in ${v.file}:${v.line} is not compliant with ${targetBaseline}. See report for details.`);
            });

            core.setFailed(`Build failed due to ${allViolations.length} Baseline violations.`);
            core.setOutput('violations-found', 'true');
        } else {
            core.info('✅ Baseline Guard passed! All scanned features meet the target criteria.');
            core.setOutput('violations-found', 'false');
        }

    } catch (error) {
        core.setFailed(`Action failed with error: ${error.message}`);
    }
}

run();
