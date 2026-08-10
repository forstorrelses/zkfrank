// End-to-end demo against a local network: read a card issued by
// scripts/issue_card.mjs, privately claim the discount, then show the same card
// being refused a second time on the same day.
//
// The pipeline itself lives in lib/claim.mjs, shared with the visualiser in
// frontend/server.mjs. This file is only the console rendering of it.
//
// Usage: node --env-file=.env scripts/validate_demo.mjs

import { runClaim } from './lib/claim.mjs';

const LINES = {
    'card:waiting': () => 'card    : waiting for a tap...',
    'card:read': (d) => `card    : student ${d.studentId}, signature ${d.signaturePreview}...`,
    'contract:ready': (d) => `contract: ${d.address}\nstudent : ${d.student}`,
    day: (d) => `day     : ${d.day}`,
    'proof:start': () => 'proof   : building...',
    'claim:ok': (d) => `claim   : accepted in ${d.ms} ms`,
    'block:mined': (d) =>
        `block   : #${d.number} ${d.hash.slice(0, 18)}... tx ${d.txHash.slice(0, 18)}...`,
    'replay:start': () => 'replay  : claiming the same card again, same day...',
    'replay:blocked': (d) => `replay  : rejected, nullifier ${d.nullifier} already spent`,
    done: () => 'done',
};

await runClaim((stage, data) => {
    const render = LINES[stage];
    if (render) {
        console.log(render(data));
    }
});
