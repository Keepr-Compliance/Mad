// BACKLOG-2576 §2 — H4: the cold-pool fallback is unbounded SYNCHRONOUS work on
// the thread that must answer the IPC. Does it actually block the event loop?
// Seeded at the founder's scale (~1,136 contacts) with the real projection shape.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT,
    is_imported INTEGER DEFAULT 1, removed_at TEXT, last_inbound_at TEXT, last_outbound_at TEXT);
  CREATE TABLE contact_emails (contact_id TEXT, email TEXT, is_primary INTEGER DEFAULT 0);
  CREATE TABLE contact_phones (contact_id TEXT, phone_e164 TEXT, is_primary INTEGER DEFAULT 0);
  CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, participants TEXT, sent_at TEXT);
  CREATE INDEX idx_ce ON contact_emails(contact_id);
  CREATE INDEX idx_cp ON contact_phones(contact_id);
`);
const U="u1", N=1136, M=50000;
db.exec("BEGIN");
const ic=db.prepare("INSERT INTO contacts (id,user_id,display_name) VALUES (?,?,?)");
const ie=db.prepare("INSERT INTO contact_emails (contact_id,email,is_primary) VALUES (?,?,?)");
const ip=db.prepare("INSERT INTO contact_phones (contact_id,phone_e164,is_primary) VALUES (?,?,?)");
const im=db.prepare("INSERT INTO messages (id,user_id,participants,sent_at) VALUES (?,?,?,?)");
for(let i=0;i<N;i++){const id=`c-${i}`;ic.run(id,U,`Person ${i}`);
  ie.run(id,`p${i}.a@example.com`,1);ie.run(id,`p${i}.b@example.com`,0);
  ip.run(id,`+1408555${String(100+(i%100)).padStart(4,"0")}`,1);}
for(let i=0;i<M;i++) im.run(`m-${i}`,U,JSON.stringify({from:`Person ${i%300}`}),`2026-08-01T10:00:00.000Z`);
db.exec("COMMIT");

const SQL=`SELECT c.*, c.display_name as name,
  COALESCE((SELECT email FROM contact_emails WHERE contact_id=c.id AND is_primary=1 LIMIT 1),
           (SELECT email FROM contact_emails WHERE contact_id=c.id LIMIT 1)) as email,
  (SELECT json_group_array(email) FROM contact_emails WHERE contact_id=c.id) as all_emails_json,
  (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id=c.id) as all_phones_json
  FROM contacts c WHERE c.user_id=? AND c.is_imported=1 ORDER BY c.display_name ASC`;
const MSG=`SELECT 'msg_'||LOWER(json_extract(participants,'$.from')) as id, MAX(sent_at) as t
  FROM messages WHERE user_id=? AND participants IS NOT NULL
   AND json_extract(participants,'$.from') NOT LIKE '%@%'
   AND json_extract(participants,'$.from') NOT LIKE '+%'
   AND json_extract(participants,'$.from') NOT GLOB '[0-9]*'
  GROUP BY LOWER(json_extract(participants,'$.from')) ORDER BY t DESC LIMIT 200`;

// An event-loop heartbeat. If the fallback blocks the thread, ticks STOP.
let ticks=0, maxGap=0, last=performance.now();
const hb=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},10);
await new Promise(r=>setTimeout(r,120)); // baseline
const baselineTicks=ticks, baselineGap=maxGap;
maxGap=0; last=performance.now();

const t0=performance.now();
db.prepare(SQL).all(U);
db.prepare(MSG).all(U);
const elapsed=performance.now()-t0;
await new Promise(r=>setTimeout(r,50));
clearInterval(hb);

console.log(`contacts=${N}  messages=${M}`);
console.log(`sync fallback (imported query + message-derived scan): ${elapsed.toFixed(1)}ms`);
console.log(`baseline heartbeat: ${baselineTicks} ticks in 120ms, max gap ${baselineGap.toFixed(1)}ms`);
console.log(`DURING the fallback: max event-loop gap ${maxGap.toFixed(1)}ms  <-- the thread is blocked this long`);
console.log(`the main process cannot answer ANY ipc for that window; there is no timeout on this path`);
