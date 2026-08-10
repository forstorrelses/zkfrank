// The claim pipeline: read a card, prove the credential privately, claim the
// discount, then show the same card failing a second time on the same day.
//
// Lives here rather than in validate_demo.mjs because two callers need it - the
// CLI demo and the visualiser in frontend/server.mjs - and a pipeline that
// exists twice drifts. Every step reports through `emit`, so a caller can print
// lines, stream events to a browser, or ignore them entirely.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { getInitialTestAccountsData } from '@aztec/accounts/testing';
import { Contract } from '@aztec/aztec.js/contracts';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { loadContractArtifact } from '@aztec/aztec.js/abi';

const NODE_URL = 'http://localhost:8080';
const ARTIFACT = new URL('../../circuits/target/zkfrank_contract-StudentId.json', import.meta.url);
const STATE_FILE = new URL('../../.zkfrank-state.json', import.meta.url);

export function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Asks the Pi to do one thing. `action` is 'read' or 'write' and nothing else:
 * backend/pi_agent.sh is the forced command on that key and refuses anything it
 * does not recognise. No path or argument from this side reaches a shell there.
 */
export function askPi(action, input) {
    return execFileSync('ssh', [
        '-p', requireEnv('ZKFRANK_PI_PORT'), requireEnv('ZKFRANK_PI_HOST'), action,
    ], {
        input,
        encoding: 'utf8',
        // stdout captured, stderr inherited so the reader's "Tap a card..."
        // prompt still reaches whoever is watching.
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
    });
}

// Pull the credential off an NFC card. The Pi is the only machine wired to the
// reader, so the reader runs there and we parse what it prints.
function readCard() {
    const stdout = askPi('read');
    const { student_id, secret, signature } = JSON.parse(stdout);
    if (student_id === undefined || secret === undefined || signature === undefined) {
        throw new Error(`Card payload is missing student_id, secret or signature: ${stdout}`);
    }

    // The signature travels as hex and the contract wants [u8; 64], so it is
    // spread into a plain array of byte values - aztec.js does not take a Buffer.
    const signatureBytes = [...Buffer.from(signature, 'hex')];
    if (signatureBytes.length !== 64) {
        throw new Error(`Card signature must be 64 bytes, got ${signatureBytes.length}`);
    }

    // BigInt, not Number: a Field element runs up to 254 bits and float64 would
    // silently round it. aztec.js takes bigint directly as a FieldLike argument.
    return {
        studentId: BigInt(student_id),
        secret: BigInt(secret),
        signature: signatureBytes,
    };
}

/**
 * Runs one full claim. `emit(stage, data)` is called as each step completes.
 *
 * Nothing is caught and turned into a return value: a failure here means the
 * card, the network or the contract is wrong, and the caller has to see that.
 * The one exception is the replay attempt, whose failure IS the result.
 */
export async function runClaim(emit) {
    if (!existsSync(STATE_FILE)) {
        throw new Error('No .zkfrank-state.json - run scripts/issue_card.mjs first to issue a card');
    }
    const { contractAddress } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

    // 1. Read the card first: a missing or blank card should fail before we
    // spend time connecting to anything.
    emit('card:waiting', {});
    const { studentId, secret, signature } = readCard();
    emit('card:read', {
        studentId: studentId.toString(),
        // Deliberately not sending the secret anywhere: the point of the whole
        // scheme is that it stays on the card and in this process.
        secretLength: secret.toString(2).length,
        signaturePreview: Buffer.from(signature).toString('hex').slice(0, 16),
    });

    // 2. Wallet with an in-process PXE. Ephemeral state, proving disabled for speed.
    const wallet = await EmbeddedWallet.create(NODE_URL, {
        ephemeral: true,
        pxe: { proverEnabled: false },
    });

    const accountsData = await getInitialTestAccountsData();
    const [, student] = await Promise.all(
        accountsData.map(async (a) =>
            (await wallet.createSchnorrAccount(a.secret, a.salt, a.signingKey)).address
        ),
    );

    // 3. Attach to the contract issue_card.mjs deployed. Contract.at() alone is
    // not enough: knowing a contract exists at an address is PXE state, and this
    // PXE was created empty. The node has the instance, the deployment having
    // been published.
    const artifact = loadContractArtifact(JSON.parse(readFileSync(ARTIFACT, 'utf8')));
    const node = createAztecNodeClient(NODE_URL);
    const instance = await node.getContract(AztecAddress.fromString(contractAddress));
    if (!instance) {
        throw new Error(
            `The node knows no contract at ${contractAddress}. The local network was ` +
                'probably restarted since the card was issued - run scripts/issue_card.mjs again.',
        );
    }
    await wallet.registerContract(instance, artifact);
    // at() is synchronous despite its docstring; contract/contract.d.ts:21 is
    // authoritative.
    const contract = Contract.at(instance.address, artifact, wallet);
    emit('contract:ready', { address: contract.address.toString(), student: student.toString() });

    // 4. Ask the chain what day it is. The local network warps its clock forward,
    // so a day derived from this machine's clock would drift out of agreement
    // with the contract and validate() would revert with "Wrong day".
    const { result: day } = await contract.methods.current_day().simulate({ from: student });
    emit('day', { day: day.toString() });

    // 5. The claim. One proof attests to three things at once: the student knows
    // the secret behind a registered commitment, the college signed that
    // commitment, and this is the first claim today.
    emit('proof:start', {});
    const startedAt = Date.now();
    const { receipt } = await contract.methods
        .validate(studentId, secret, signature, day)
        .send({ from: student });
    emit('claim:ok', { ms: Date.now() - startedAt });

    // 5b. The block the claim landed in. TxReceipt declares blockNumber and
    // blockHash optional because the same type also describes a pending tx;
    // send() waits for mining, so on this path they are always set and their
    // absence means the receipt is not what we think it is.
    if (receipt.blockNumber === undefined || receipt.blockHash === undefined) {
        throw new Error(`Mined receipt without a block: ${JSON.stringify(receipt)}`);
    }
    // The timestamp has to come from the block, not from Date.now(): the local
    // network warps its clock forward, and the wall clock here would disagree
    // with the chain by days.
    const header = await node.getBlockHeader(receipt.blockNumber);
    if (!header) {
        throw new Error(`The node has no header for block ${receipt.blockNumber}`);
    }
    emit('block:mined', {
        number: receipt.blockNumber,
        hash: receipt.blockHash.toString(),
        txHash: receipt.txHash.toString(),
        status: receipt.status,
        // Seconds since the epoch as a Number: it is a bigint on the header and
        // JSON.stringify refuses to serialise those.
        timestamp: Number(header.globalVariables.timestamp),
    });

    // 6. The same card, the same day, a second time. This failure is the result,
    // so it is the one place a catch belongs.
    emit('replay:start', {});
    try {
        await contract.methods.validate(studentId, secret, signature, day).send({ from: student });
        emit('replay:accepted', {});
        throw new Error('The nullifier did not work: the same card claimed twice in one day');
    } catch (e) {
        if (!/duplicate siloed nullifier/i.test(e.message)) {
            throw e;
        }
        const nullifier = e.message.match(/0x[0-9a-f]+/i)?.[0] ?? 'unknown';
        emit('replay:blocked', { nullifier });
    }

    emit('done', {});
}
