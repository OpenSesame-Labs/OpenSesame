import assert from "node:assert/strict";
import { resolve } from "node:path";

export { verifyKdbxDevWorker } from "./kdbx-dev-worker-proof.mjs";

/** Added to the real browser proof entry, where sdk and host ports are in scope. */
export function kdbxAesProofEntry(root) {
  return `
import { isolatedAes, withKdbxLoad } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/vault/import/formats/kdbx-argon2-worker-client.ts"))};
globalThis.kdbxAesWorkerProof = async () => {
  let started=0, stopped=0, aesJobs=0;
  class CountingWorker extends Worker {
    constructor(url, options) { if(new URL(url,location.href).origin!==location.origin) throw new Error("KDF worker must be same-origin"); super(url, options); started++; }
    postMessage(work, transfer) { if (work.variant === "aes") aesJobs++; return super.postMessage(work, transfer); }
    terminate() { stopped++; super.terminate(); }
  }
  configureHost({ env: {}, worker: CountingWorker });
  const credentials = new Uint8Array(32).map((_, i) => i);
  const key = new Uint8Array(32).map((_, i) => 255-i);
  const equal = (a,b) => a.length === b.length && a.every((byte,i) => byte === b[i]);
  const vectors=[];
  for (const rounds of [1, 10, 10000, 10001]) {
    const expected=await sdk.KeyEncryptorAes.encrypt(credentials,key,rounds);
    const actual=await isolatedAes(credentials,key,rounds);
    vectors.push(equal(actual,expected));
  }
  const input=(bytes)=>({fileName:"aes.kdbx",text:"",headers:null,json:null,bytes:new Uint8Array(bytes),password:"test password"});
  const create=(major)=>{
    const db=sdk.Kdbx.create(new sdk.Credentials(sdk.ProtectedValue.fromString("test password")),"AES proof");
    if (major===3) { db.setVersion(3); db.header.keyEncryptionRounds=10; }
    else { db.setKdf(sdk.Consts.KdfId.Aes); db.header.kdfParameters.set("R",sdk.VarDictionary.ValueType.UInt64,new sdk.Int64(10)); }
    const item=db.createEntry(db.getDefaultGroup());
    item.fields.set("Title", "AES worker entry");
    item.fields.set("Password",sdk.ProtectedValue.fromString("AES worker secret"));
    return db;
  };
  const files=[await create(3).save(),await create(4).save()];
  const imports=[];
  for (const file of files) {
    const prior=aesJobs;
    const parsed=await keepassKdbx.parse(input(file));
    imports.push({jobs:aesJobs-prior,name:parsed.items[0]?.name,secret:parsed.items[0]?.password});
  }
  let wrongPassword=false;
  try { await keepassKdbx.parse({...input(files[0]),password:"wrong"}); }
  catch (error) { wrongPassword=String(error).includes("password did not open"); }
  configureHost({ env: {} });
  const unsupported=[];
  for (const file of files) {
    try { await keepassKdbx.parse(input(file)); unsupported.push(false); }
    catch (error) { unsupported.push(String(error).includes("cannot safely open")); }
  }
  let terminated=0, heartbeats=0;
  class HangingWorker extends Worker {
    constructor(_url, options) { super("/hanging-worker.mjs",options); }
    terminate() { terminated++; super.terminate(); }
  }
  configureHost({ env: {}, worker: HangingWorker });
  const actualTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(callback,delay,...args)=>actualTimeout(callback,delay===30000?100:delay,...args);
  const heartbeat=setInterval(()=>heartbeats++,10);
  let blocked=false, timeout=false, cancelled=false;
  try {
    const pending=isolatedAes(credentials,key,100);
    try { await isolatedArgon2.argon2id({password:credentials,salt:key,memorySize:1024,iterations:1,parallelism:1,hashLength:32,outputType:"binary"}); }
    catch (error) { blocked=String(error).includes("already opening"); }
    try { await pending; } catch (error) { timeout=String(error).includes("took too long"); }
    const controller=new AbortController();
    const aborting=withKdbxLoad(controller.signal,()=>isolatedAes(credentials,key,100));
    controller.abort();
    try { await aborting; } catch (error) { cancelled=String(error).includes("cancelled"); }
  } finally {
    globalThis.setTimeout=actualTimeout;
    clearInterval(heartbeat);
    configureHost({ env: {}, worker: TrackedWorker });
  }
  return { vectors, imports, wrongPassword, unsupported, started, stopped, blocked, timeout, cancelled, terminated, heartbeats };
};
`;
}

export function assertKdbxAesProof(result) {
  assert.deepEqual(result.vectors, [true, true, true, true]);
  assert.deepEqual(result.imports, [
    { jobs: 1, name: "AES worker entry", secret: "AES worker secret" },
    { jobs: 1, name: "AES worker entry", secret: "AES worker secret" },
  ]);
  assert.deepEqual(result.unsupported, [true, true]);
  assert.equal(result.wrongPassword, true);
  assert.equal(result.started, result.stopped);
  assert.equal(result.started, 7);
  assert.equal(result.blocked, true);
  assert.equal(result.timeout, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.terminated, 2);
  assert(result.heartbeats > 0);
}
