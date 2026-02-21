/* eslint-disable no-console */
require('dotenv').config();

const os = require('os');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { Indexer, ZgFile, getFlowContract } = require('@0glabs/0g-ts-sdk');

async function main() {
  const rpcUrl = process.env.ZG_RPC_URL || 'https://evmrpc-testnet.0g.ai';
  const indexerRpc = process.env.ZG_INDEXER_RPC || 'https://indexer-storage-testnet-turbo.0g.ai';
  const flowAddressEnv = process.env.ZG_FLOW_CONTRACT || null;
  const privateKey = process.env.ZG_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('Missing ZG_PRIVATE_KEY');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(indexerRpc);

  const chainId = (await provider.getNetwork()).chainId.toString();
  const balance = ethers.formatEther(await provider.getBalance(await signer.getAddress()));
  const [nodes, nodeErr] = await indexer.selectNodes(1);
  const firstNodeStatus = nodes?.[0] ? await nodes[0].getStatus() : null;
  const flowAddress = (firstNodeStatus?.networkIdentity?.flowAddress || flowAddressEnv || '').toString();

  const report = {
    timestamp: new Date().toISOString(),
    chainId,
    rpcUrl,
    indexerRpc,
    signerAddress: await signer.getAddress(),
    signerBalance: balance,
    flowAddress,
    nodeSelectionError: nodeErr ? String(nodeErr) : null,
    selectedNodes: nodes?.map((n) => n.url) ?? [],
    firstNodeStatus,
    checks: {},
  };

  const tmpFile = path.join(os.tmpdir(), `zg-diagnose-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, JSON.stringify({ ping: true, t: Date.now() }), 'utf-8');
  const file = await ZgFile.fromFilePath(tmpFile);

  try {
    const [tree, treeErr] = await file.merkleTree();
    report.checks.merkle = treeErr ? { ok: false, error: String(treeErr) } : { ok: true, rootHash: tree.rootHash() };

    const [submission, subErr] = await file.createSubmission('0x');
    report.checks.createSubmission = subErr
      ? { ok: false, error: String(subErr) }
      : {
        ok: true,
        submissionKeys: submission ? Object.keys(submission) : [],
        dataLength: typeof submission?.data === 'string'
          ? submission.data.length
          : Array.isArray(submission?.data)
            ? submission.data.length
            : null,
        nodesLength: submission.nodes?.length ?? 0,
      };

    if (submission && flowAddress) {
      const flow = getFlowContract(flowAddress, signer);
      try {
        const market = await flow.market();
        report.checks.flowMarket = { ok: true, market };
      } catch (err) {
        report.checks.flowMarket = { ok: false, error: String(err) };
      }

      try {
        const est = await flow.submit.estimateGas(submission, { value: 0n });
        report.checks.estimateSubmitZero = { ok: true, gas: est.toString() };
      } catch (err) {
        report.checks.estimateSubmitZero = { ok: false, error: String(err) };
      }
    }

    try {
      const [tx, uploadErr] = await indexer.upload(file, rpcUrl, signer);
      report.checks.indexerUpload = uploadErr
        ? { ok: false, tx, error: String(uploadErr) }
        : { ok: true, tx };
    } catch (err) {
      report.checks.indexerUpload = { ok: false, error: String(err) };
    }

    try {
      const [txWithGas, uploadErrWithGas] = await indexer.upload(
        file,
        rpcUrl,
        signer,
        undefined,
        undefined,
        { gasLimit: 5_000_000n }
      );
      let receipt = null;
      const txHash = txWithGas && typeof txWithGas === 'object' ? txWithGas.txHash : null;
      if (txHash) {
        receipt = await provider.getTransactionReceipt(txHash);
      }
      report.checks.indexerUploadWithGas = uploadErrWithGas
        ? { ok: false, tx: txWithGas, receipt, error: String(uploadErrWithGas) }
        : { ok: true, tx: txWithGas, receipt };
    } catch (err) {
      report.checks.indexerUploadWithGas = { ok: false, error: String(err) };
    }
  } finally {
    await file.close().catch(() => undefined);
    fs.unlinkSync(tmpFile);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[diag:0g-submit] fatal:', err);
  process.exit(1);
});
