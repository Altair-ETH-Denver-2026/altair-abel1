#!/usr/bin/env node
/**
 * Patches @0glabs/0g-ts-sdk to match the current 0G Galileo testnet contract ABI.
 *
 * The Submission struct was updated on-chain to add an `address submitter` field,
 * changing the submit() selector from 0xef3e12dc → 0xbc8c11f8.
 * The npm package (v0.3.3) still ships the old ABI, so we patch it here.
 *
 * See: https://github.com/MattWong-ca/ethdenver-2026/blob/main/templates/storage/scripts/patch-0g-sdk.js
 */

const fs = require('fs');
const path = require('path');

const SDK = '@0glabs/0g-ts-sdk';

function findSdkRoot() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', SDK),
    path.join(__dirname, '..', 'packages', 'web', 'node_modules', SDK),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Old Submission: flat (length, tags, nodes). Replaced in all 3 places (Submit event, batchSubmit, submit).
const OLD_SUBMIT_ABI = `                components: [
                    {
                        internalType: "uint256",
                        name: "length",
                        type: "uint256",
                    },
                    {
                        internalType: "bytes",
                        name: "tags",
                        type: "bytes",
                    },
                    {
                        components: [
                            {
                                internalType: "bytes32",
                                name: "root",
                                type: "bytes32",
                            },
                            {
                                internalType: "uint256",
                                name: "height",
                                type: "uint256",
                            },
                        ],
                        internalType: "struct SubmissionNode[]",
                        name: "nodes",
                        type: "tuple[]",
                    },
                ],`;

// New Submission: { data: SubmissionData, submitter: address } to match testnet.
const NEW_SUBMIT_ABI = `                components: [
                    {
                        components: [
                            {
                                internalType: "uint256",
                                name: "length",
                                type: "uint256",
                            },
                            {
                                internalType: "bytes",
                                name: "tags",
                                type: "bytes",
                            },
                            {
                                components: [
                                    {
                                        internalType: "bytes32",
                                        name: "root",
                                        type: "bytes32",
                                    },
                                    {
                                        internalType: "uint256",
                                        name: "height",
                                        type: "uint256",
                                    },
                                ],
                                internalType: "struct SubmissionNode[]",
                                name: "nodes",
                                type: "tuple[]",
                            },
                        ],
                        internalType: "struct SubmissionData",
                        name: "data",
                        type: "tuple",
                    },
                    {
                        internalType: "address",
                        name: "submitter",
                        type: "address",
                    },
                ],`;

const OLD_UPLOADER_LINE = `[submission], txOpts, retryOpts)`;
const NEW_UPLOADER_LINE = `[{ data: submission, submitter: await this.flow.runner.getAddress() }], txOpts, retryOpts)`;

function patchFile(filePath, oldStr, newStr, label, replaceAll = false) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(oldStr)) {
    console.log(`  skip (already patched or no match): ${label}`);
    return;
  }
  const newContent = replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, newStr);
  if (newContent === content) {
    console.log(`  skip (no change): ${label}`);
    return;
  }
  fs.writeFileSync(filePath, newContent);
  console.log(`  patched: ${label}`);
}

const sdkRoot = findSdkRoot();
if (!sdkRoot) {
  console.log('patch-0g-sdk: SDK not found, skipping.');
  process.exit(0);
}

console.log(`patch-0g-sdk: found SDK at ${sdkRoot}`);

for (const variant of ['lib.esm', 'lib.commonjs']) {
  const factoryPath = path.join(sdkRoot, variant, 'contracts', 'flow', 'factories', 'FixedPriceFlow__factory.js');
  const uploaderPath = path.join(sdkRoot, variant, 'transfer', 'Uploader.js');
  patchFile(factoryPath, OLD_SUBMIT_ABI, NEW_SUBMIT_ABI, `${variant}/FixedPriceFlow__factory.js`, true);
  patchFile(uploaderPath, OLD_UPLOADER_LINE, NEW_UPLOADER_LINE, `${variant}/Uploader.js`);
}

console.log('patch-0g-sdk: done.');
