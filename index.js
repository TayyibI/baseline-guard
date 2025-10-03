const core = require('@actions/core');
const { features } = require('web-features');
const { toDate } = require('./utils');
const fs = require('fs');
const path = require('path');
const doiuse = require('doiuse');
const { glob } = require('glob');

let features;

try {
    const webFeatures = require('web-features');
    features = webFeatures.features || webFeatures.default?.features || {};
    core.debug('Loaded web-features: ' + JSON.stringify(Object.keys(features).slice(0, 5)));
} catch (error) {
    core.setFailed(`Failed to load web-features: ${error.message}`);
    process.exit(1);
}

// ... rest of your index.js code (getCompliantFeatureIds, run, etc.) ...
/**
 * Maps the user's target-baseline input to a list of feature IDs that meet that standard.
 * @param {string} target The user input (e.g., 'widely', 'newly', '2023').
 * @param {boolean} failOnNewly If true, 'newly' available features are considered non-compliant.
 * @returns {Set<string>} A Set of Baseline compliant feature IDs.
 */
function getCompliantFeatureIds(target, failOnNewly) {
    const compliantIds = new Set();
    const allFeatures = Object.values(features);
    
    const lowerTarget = target.toLowerCase();

    for (const feature of allFeatures) {
        const status = feature.status?.baseline;
        const highDate = feature.baseline_high_date;
        const lowDate = feature.baseline_low_date;
        
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
        }
    }
    
    return compliantIds;
}

async function run() {
    try {
        // 1. Read Inputs
        const targetBaseline = core.getInput('target-baseline');
        const scanFiles = core.getInput('scan-files');
        const failOnNewly = core.getInput('fail-on-newly') === 'true';
        const reportArtifactName = core.getInput('report-artifact-name');

        core.info('--- Baseline Guard Configuration ---');
        core.info(`Target Baseline: ${targetBaseline}`);
        core.info(`Files to Scan: ${scanFiles}`);
        core.info(`Fail on Newly Available: ${failOnNewly}`);
        core.info(`Report Name: ${reportArtifactName}`);
        core.info('------------------------------------');

        // 2. Get Compliant Features (Phase 2)
        const compliantFeatureIds = getCompliantFeatureIds(targetBaseline, failOnNewly);
        core.info(`Found ${compliantFeatureIds.size} features matching Baseline criteria.`);

        // 3. Scan CSS Files (Phase 3)
        const allViolations = [];
        const filePaths = await glob(scanFiles, { ignore: 'node_modules/**' });

        for (const filePath of filePaths) {
            if (filePath.endsWith('.css')) {
                const cssContent = fs.readFileSync(filePath, 'utf-8');

                // Process CSS content with doiuse
                doiuse({
                    browsers: [], // Empty since we're using a custom feature list
                    onFeatureUsage: (usage) => {
                        const featureId = usage.feature; // doiuse uses BCD keys
                        if (!compliantFeatureIds.has(featureId)) {
                            allViolations.push({
                                file: filePath,
                                line: usage.line || 'unknown',
                                feature: featureId,
                                reason: `Not found in Baseline Target: ${targetBaseline}`
                            });
                        }
                    }
                }).process(cssContent, { from: filePath });
            }
        }

        // 4. CI Gate Logic
        if (allViolations.length > 0) {
            core.warning(`❌ Baseline Guard found ${allViolations.length} violations against the ${targetBaseline} target.`);

            // Placeholder for report generation (Phase 4)
            const reportPath = 'baseline-guard-report.md';
            const reportContent = allViolations.map(v =>
                `[VIOLATION] ${v.feature} in ${v.file}:${v.line} - ${v.reason}`
            ).join('\n');
            fs.writeFileSync(reportPath, reportContent);

            allViolations.forEach(v => {
                core.error(`[VIOLATION] ${v.feature} in ${v.file}:${v.line} - ${v.reason}`);
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