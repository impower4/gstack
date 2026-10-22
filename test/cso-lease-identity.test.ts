import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateRoot, recoverAtomicNoReplaceJson, retention, withLock } from '../lib/cso/state';
import { darwinIdentityFromBsdInfo, identityStartedAtMs, PROCESS_IDENTITY, processIdentitySource } from '../lib/cso/process-identity';
import { dispatchCsoCommand } from '../lib/cso/cli';
import { RUNTIME_CATALOG } from '../lib/cso/runtime-catalog';

const roots:string[]=[];
const tmp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-lease-identity-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function syntheticIds(root:string,first:bigint,step=1n):()=>void{
  const lstat=fs.lstatSync.bind(fs),fstat=fs.fstatSync.bind(fs),ids=new Map<string,bigint>();
  const map=(stat:fs.Stats|fs.BigIntStats,bigint:boolean)=>{
    const key=`${stat.dev}:${stat.ino}`;
    if(!ids.has(key))return stat;
    const ino=ids.get(key)!;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{dev:bigint?first:Number(first),ino:bigint?ino:Number(ino)});
  };
  const pathSpy=spyOn(fs,'lstatSync').mockImplementation(((file:any,options?:any)=>{
    const stat=lstat(file,options);
    if(String(file).startsWith(root+path.sep)){
      const key=`${stat.dev}:${stat.ino}`;
      if(!ids.has(key))ids.set(key,first+step*BigInt(ids.size));
    }
    return map(stat,options?.bigint===true);
  }) as typeof fs.lstatSync);
  const fdSpy=spyOn(fs,'fstatSync').mockImplementation(((fd:any,options?:any)=>map(fstat(fd,options),options?.bigint===true)) as typeof fs.fstatSync);
  return()=>{fdSpy.mockRestore();pathSpy.mockRestore();};
}

function leaseFixture(dir:string,ownerPid:number,token:string){
  withLock(dir,()=>0);
  const leases=path.join(dir,'.mutation-lock-leases'),candidate=path.join(leases,`${token}.json`),decision=path.join(leases,`${token}.decision`);
  fs.writeFileSync(candidate,JSON.stringify({pid:ownerPid,token,createdAt:0})+'\n',{mode:0o600});
  const stat=fs.lstatSync(candidate,{bigint:true});
  fs.writeFileSync(decision,JSON.stringify({schemaVersion:1,token,kind:'ticket',ticket:'0000000000000001',candidateDev:String(stat.dev),candidateIno:String(stat.ino),ownerPid,ownerCreatedAt:0,publisherPid:ownerPid,createdAt:0})+'\n',{mode:0o600});
  return {leases,candidate,decision,stat};
}

describe('CSO exact filesystem lease identity',()=>{
  test('the last safe integer and its next inode remain distinct',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740991n);
    try{
      const first=path.join(dir,'first'),second=path.join(dir,'second');
      fs.writeFileSync(first,'a');fs.writeFileSync(second,'b');
      expect(fs.lstatSync(first,{bigint:true}).ino).toBe(9007199254740991n);
      expect(fs.lstatSync(second,{bigint:true}).ino).toBe(9007199254740992n);
      expect(withLock(dir,()=>1)).toBe(1);
    }finally{restore();}
  });

  test.each([9007199254740991n,9007199254740992n,9007199254740993n])('serializes and releases identity starting at %s across consecutive mutations',(first)=>{
    const dir=tmp(),restore=syntheticIds(dir,first);
    try{
      for(let i=0;i<4;i++)expect(withLock(dir,()=>{
        const leases=path.join(dir,'.mutation-lock-leases'),files=fs.readdirSync(leases);
        const candidate=path.join(leases,files.find(name=>name.endsWith('.json'))!),decision=path.join(leases,files.find(name=>name.endsWith('.decision'))!),record=JSON.parse(fs.readFileSync(decision,'utf8'));
        expect(record.candidateDev).toBe(String(fs.lstatSync(candidate,{bigint:true}).dev));
        expect(record.candidateIno).toBe(String(fs.lstatSync(candidate,{bigint:true}).ino));
        expect(BigInt(record.candidateIno)).toBeGreaterThanOrEqual(first);
        return i;
      })).toBe(i);
      expect(fs.readdirSync(path.join(dir,'.mutation-lock-leases'))).toEqual([]);
    }finally{restore();}
  });

  test('recovers a dead owner and its exact high-ID decision, then admits the next operation',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {leases,candidate,decision}=leaseFixture(dir,2147483647,'a'.repeat(32));
      expect(withLock(dir,()=>1)).toBe(1);
      expect(fs.existsSync(candidate)).toBe(false);expect(fs.existsSync(decision)).toBe(false);
      expect(withLock(dir,()=>2)).toBe(2);expect(fs.readdirSync(leases)).toEqual([]);
    }finally{restore();}
  });

  test('a decision left after exact candidate removal keeps its high ID until recovery',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {leases,candidate,decision,stat}=leaseFixture(dir,2147483647,'e'.repeat(32));
      expect(JSON.parse(fs.readFileSync(decision,'utf8')).candidateIno).toBe(String(stat.ino));
      fs.unlinkSync(candidate);
      expect(withLock(dir,()=>3)).toBe(3);
      expect(fs.readdirSync(leases)).toEqual([]);
    }finally{restore();}
  });

  test('a live foreign lease is not stolen, even when its timestamp is old',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {candidate,decision}=leaseFixture(dir,process.pid,'b'.repeat(32));
      expect(()=>withLock(dir,()=>1)).toThrow('Another operation in this helper');
      expect(fs.existsSync(candidate)).toBe(true);expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('a legacy rounded high-ID decision is ambiguous and remains blocked',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740993n,2n);
    try{
      const token='c'.repeat(32),{candidate,decision,stat}=leaseFixture(dir,2147483647,token);
      expect(stat.ino%2n).toBe(1n);
      const record=JSON.parse(fs.readFileSync(decision,'utf8'));
      record.candidateIno=String(Number(stat.ino));
      fs.writeFileSync(decision,JSON.stringify(record)+'\n',{mode:0o600});
      expect(record.candidateIno).not.toBe(String(stat.ino));
      let failure:unknown;try{withLock(dir,()=>1);}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.existsSync(candidate)).toBe(true);expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('a neighboring replacement inode is rejected during exact release',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      let replaced='';
      let failure:unknown;try{withLock(dir,()=>{
        const leases=path.join(dir,'.mutation-lock-leases'),active=fs.readdirSync(leases).find(name=>name.includes('.active.'))!;
        replaced=path.join(leases,active);const bytes=fs.readFileSync(replaced);
        fs.renameSync(replaced,`${replaced}.original`);fs.writeFileSync(replaced,bytes,{mode:0o600});
      });}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'PERSISTENCE_FAILED'});
      expect(fs.existsSync(replaced)).toBe(true);
    }finally{restore();}
  });

  test.skipIf(process.platform==='win32')('a symlink substituted for a dead owner is never reclaimed',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const {candidate,decision}=leaseFixture(dir,2147483647,'f'.repeat(32)),original=`${candidate}.original`;
      fs.renameSync(candidate,original);fs.symlinkSync(original,candidate);
      let failure:unknown;try{withLock(dir,()=>1);}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.lstatSync(candidate).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(decision)).toBe(true);
    }finally{restore();}
  });

  test('atomic recovery matches only the exact high-ID hard-link publication',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`;
      fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});fs.linkSync(temporary,target);
      recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});
      expect(fs.existsSync(temporary)).toBe(false);expect(JSON.parse(fs.readFileSync(target,'utf8'))).toEqual({value:'retained'});
    }finally{restore();}
  });

  test('adjacent IDs that round to the same Number cannot impersonate a publication',()=>{
    const dir=tmp(),restore=syntheticIds(dir,9007199254740992n);
    try{
      const target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`,time=new Date(1_700_000_000_000);
      fs.writeFileSync(target,'{"value":"retained"}\n',{mode:0o600});
      fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});
      fs.utimesSync(target,time,time);fs.utimesSync(temporary,time,time);
      fs.linkSync(target,path.join(dir,'other'));fs.linkSync(temporary,path.join(dir,'another'));
      const original=fs.lstatSync(target,{bigint:true}),foreign=fs.lstatSync(temporary,{bigint:true});
      expect(foreign.ino-original.ino).toBe(1n);
      expect(Number(foreign.ino)).toBe(Number(original.ino));
      let failure:unknown;try{recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});}catch(error){failure=error;}
      expect(failure).toMatchObject({code:'UNSAFE_PATH'});
      expect(fs.existsSync(temporary)).toBe(true);
      expect(fs.readFileSync(target,'utf8')).toBe('{"value":"retained"}\n');
    }finally{restore();}
  });

  test('atomic recovery rejects a same-millisecond timestamp change while the file is opened',()=>{
    const dir=tmp(),target=path.join(dir,'artifact.json'),temporary=`${target}.tmp.2147483647.deadbeef`,fstat=fs.fstatSync;
    fs.writeFileSync(temporary,'{"value":"retained"}\n',{mode:0o600});fs.linkSync(temporary,target);
    fs.utimesSync(target,1_700_000_000.0001,1_700_000_000.0001);
    let injected=false,failure:unknown;
    const reader=spyOn(fs,'fstatSync').mockImplementation(((fd:any,options?:any)=>{
      const stat=fstat(fd,options);
      if(injected||options?.bigint!==true)return stat;
      injected=true;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{mtimeNs:stat.mtimeMs*1_000_000n+600_000n});
    }) as typeof fs.fstatSync);
    try{recoverAtomicNoReplaceJson(target,{label:'Synthetic publication',maxBytes:4096});}catch(error){failure=error;}finally{reader.mockRestore();}
    expect(injected).toBe(true);
    expect(failure).toMatchObject({code:'SNAPSHOT_RACE'});
    expect(fs.existsSync(temporary)).toBe(true);
  });
});

const FILETIME_UNIX_EPOCH=116444736000000000n;
const win32Identity=(ms:number)=>`win32:${BigInt(ms)*10000n+FILETIME_UNIX_EPOCH}`;
type OwnerRecord={pid:number;token:string;createdAt:number;processIdentity?:string};
function ownedLease(dir:string,owner:OwnerRecord,active=false){
  withLock(dir,()=>0);
  const leases=path.join(dir,'.mutation-lock-leases'),candidate=path.join(leases,`${owner.token}.json`),decision=path.join(leases,`${owner.token}.decision`),activePath=path.join(leases,`${owner.token}.active.0000000000000001`);
  fs.writeFileSync(candidate,JSON.stringify(owner)+'\n',{mode:0o600});
  const stat=fs.lstatSync(candidate,{bigint:true});
  fs.writeFileSync(decision,JSON.stringify({schemaVersion:1,token:owner.token,kind:'ticket',ticket:'0000000000000001',candidateDev:String(stat.dev),candidateIno:String(stat.ino),ownerPid:owner.pid,...(owner.processIdentity?{ownerProcessIdentity:owner.processIdentity}:{}),ownerCreatedAt:owner.createdAt,publisherPid:owner.pid,...(owner.processIdentity?{publisherProcessIdentity:owner.processIdentity}:{}),createdAt:owner.createdAt})+'\n',{mode:0o600});
  if(active)fs.linkSync(candidate,activePath);
  return {leases,records:[candidate,decision,...(active?[activePath]:[])]};
}
function withHolder<T>(fn:(pid:number)=>T):T{
  const holder=Bun.spawn([process.execPath,'-e','setTimeout(()=>{},60000)'],{stdio:['ignore','ignore','ignore']});
  try{return fn(holder.pid);}finally{holder.kill();}
}
function identityAs(pid:number,identity:string|undefined){
  const original=processIdentitySource.read.bind(processIdentitySource);
  return spyOn(processIdentitySource,'read').mockImplementation((value:number)=>value===pid?identity:original(value));
}
function failureOf(fn:()=>unknown):any{try{fn();}catch(error){return error;}return undefined;}

describe('#2894 lease owner identity and stale-lease recovery',()=>{
  function unverifiableOtherRun(){
    const other=path.join(privateRoot(),'b'.repeat(24),`${Date.now()}-${'1'.repeat(16)}`);fs.mkdirSync(other,{recursive:true,mode:0o700});
    const {records}=ownedLease(other,{pid:2147483647,token:'c'.repeat(32),createdAt:1});
    const decision=JSON.parse(fs.readFileSync(records[1],'utf8'));decision.candidateIno=String(BigInt(decision.candidateIno)+1n);
    fs.writeFileSync(records[1],JSON.stringify(decision)+'\n',{mode:0o600});
    return {other,records};
  }
  function expectStillBlocked(other:string,records:string[]){
    const blocked=failureOf(()=>withLock(other,()=>1));
    expect(blocked).toMatchObject({code:'UNSAFE_PATH'});
    expect(blocked.message).toContain('does not match its candidate owner');
    expect(blocked.message).toContain('Next: start a new run');
    expect(blocked.message).not.toMatch(/delete|remove the lock/i);
    for(const record of records)expect(fs.existsSync(record)).toBe(true);
  }
  function isolatedState<T>(fn:(base:string)=>T):T{
    const previous=process.env.GSTACK_HOME,base=tmp();process.env.GSTACK_HOME=path.join(base,'state');
    const restore=()=>{if(previous===undefined)delete process.env.GSTACK_HOME;else process.env.GSTACK_HOME=previous;};
    try{const value=fn(base);if(value instanceof Promise)return value.finally(restore) as T;restore();return value;}catch(error){restore();throw error;}
  }

  test('maintenance skips another run whose lease decision cannot be verified and leaves it blocked',()=>isolatedState(()=>{
    const {other,records}=unverifiableOtherRun();
    expect(retention(Date.now()).complete).toBe(true);
    expectStillBlocked(other,records);
  }));

  test.skipIf(process.platform==='win32')('start is not blocked by another repository run whose lease decision cannot be verified',()=>isolatedState(async base=>{
    const repo=path.join(base,'repo');fs.mkdirSync(repo);
    for(const args of [['init','-q'],['config','user.email','fixture@example.test'],['config','user.name','Fixture']])expect(spawnSync('git',args,{cwd:repo,timeout:10_000}).status).toBe(0);
    fs.writeFileSync(path.join(repo,'app.js'),'console.log("fixture")\n');
    for(const args of [['add','app.js'],['commit','-qm','fixture']])expect(spawnSync('git',args,{cwd:repo,timeout:10_000}).status).toBe(0);
    const {other,records}=unverifiableOtherRun();
    const started=await dispatchCsoCommand('start',['--repo',repo,'--offline'],{runtimeCatalog:RUNTIME_CATALOG,catalogImageSession:async()=>{throw new Error('unused');},watchdogPath:()=>'/unused'} as any) as any;
    expect(started.status).toBe('running');
    expectStillBlocked(other,records);
  }),30_000);

  test('identity decoding: Windows FILETIME and macOS proc_bsdinfo start times',()=>{
    expect(identityStartedAtMs(win32Identity(1_700_000_000_123))).toBe(1_700_000_000_123);
    expect(identityStartedAtMs(`win32:${FILETIME_UNIX_EPOCH}`)).toBe(0);
    expect(identityStartedAtMs('darwin:1700000000123456')).toBe(1_700_000_000_123);
    expect(identityStartedAtMs('linux:123456')).toBeUndefined();
    const info=new Uint8Array(136),view=new DataView(info.buffer);
    view.setUint32(12,4242,true);view.setBigUint64(120,1_700_000_000n,true);view.setBigUint64(128,123_456n,true);
    expect(darwinIdentityFromBsdInfo(info,4242)).toBe('darwin:1700000000123456');
    expect(darwinIdentityFromBsdInfo(info,4243)).toBeUndefined();
    expect(darwinIdentityFromBsdInfo(info.subarray(0,135),4242)).toBeUndefined();
    for(const value of ['linux:1','win32:133000000000000000','darwin:1700000000123456'])expect(PROCESS_IDENTITY.test(value)).toBe(true);
    for(const value of ['win32:','macos:1','win32:-1','linux:1 '])expect(PROCESS_IDENTITY.test(value)).toBe(false);
  });

  test.skipIf(!['linux','darwin','win32'].includes(process.platform))('the live identity source distinguishes this process from a child',()=>{
    const own=processIdentitySource.read(process.pid);
    expect(own).toMatch(PROCESS_IDENTITY);expect(processIdentitySource.read(process.pid)).toBe(own!);
    withHolder(pid=>{const child=processIdentitySource.read(pid);expect(child).toMatch(PROCESS_IDENTITY);expect(child).not.toBe(own!);});
  });

  test('a recycled PID on Windows or macOS (holder started after the record) is reclaimed',()=>withHolder(pid=>{
    const dir=tmp(),createdAt=Date.now()-60_000,{leases,records}=ownedLease(dir,{pid,token:'a'.repeat(32),createdAt});
    for(const identity of [win32Identity(Date.now()-1_000),`darwin:${BigInt(Date.now()-1_000)*1000n}`]){
      const spy=identityAs(pid,identity);
      try{expect(withLock(dir,()=>7)).toBe(7);}finally{spy.mockRestore();}
      for(const record of records)expect(fs.existsSync(record)).toBe(false);
      expect(fs.readdirSync(leases)).toEqual([]);
      ownedLease(dir,{pid,token:'a'.repeat(32),createdAt});
    }
  }));

  test('a holder that started before the record, or a record with no creation time, is never stolen',()=>withHolder(pid=>{
    for(const [createdAt,started] of [[Date.now()-1_000,Date.now()-60_000],[0,Date.now()-1_000]]){
      const dir=tmp(),{records}=ownedLease(dir,{pid,token:'b'.repeat(32),createdAt},true),spy=identityAs(pid,win32Identity(started));
      let failure:any;try{failure=failureOf(()=>withLock(dir,()=>1));}finally{spy.mockRestore();}
      expect(failure).toMatchObject({code:'INSUFFICIENT_CAPACITY'});
      expect(failure.message).toContain(`process ${pid} is running and the lease record predates process identity`);
      for(const record of records)expect(fs.existsSync(record)).toBe(true);
    }
  }));

  test('an unknown identity stays conservative and names the owner pid with a safe next step',()=>withHolder(pid=>{
    const dir=tmp(),{records}=ownedLease(dir,{pid,token:'d'.repeat(32),createdAt:Date.now(),processIdentity:win32Identity(Date.now()-5_000)},true),spy=identityAs(pid,undefined);
    let failure:any;try{failure=failureOf(()=>withLock(dir,()=>1));}finally{spy.mockRestore();}
    expect(failure).toMatchObject({code:'INSUFFICIENT_CAPACITY'});
    expect(failure.message).toContain('Another helper is updating this run');
    expect(failure.message).toContain(`process ${pid} is running; process identity unavailable`);
    expect(failure.message).toContain('Status: blocked; this command changed nothing');
    expect(failure.message).toContain('wait for that session to finish or check the owning session');
    expect(failure.message).not.toMatch(/delete|remove the lock/i);
    for(const record of records)expect(fs.existsSync(record)).toBe(true);
  }));

  // A second helper process runs while this one is suspended at one point of its
  // reclaim. Whatever the interleaving, exactly one helper acquires the lease and
  // the recycled-PID records are consumed once.
  const contender=(dir:string,script:string)=>{
    const result=spawnSync(process.execPath,[script,dir],{encoding:'utf8',timeout:30_000});
    expect(result.status).toBe(0);return JSON.parse(result.stdout.trim());
  };
  test.skipIf(process.platform!=='linux').each([
    ['while the first helper is reclaiming','unlinkSync','.json','second'],
    ['after the first helper holds its ticket','linkSync','.active.','first'],
  ] as const)('two helpers racing for a recycled-PID lease: %s',(_name,hook,marker,winner)=>withHolder(pid=>{
    const dir=tmp(),script=path.join(dir,'..',`${path.basename(dir)}-contender.ts`);roots.push(script);
    fs.writeFileSync(script,`import {withLock} from ${JSON.stringify(path.resolve(import.meta.dir,'../lib/cso/state'))};
try{withLock(process.argv[2],()=>0);console.log(JSON.stringify({won:true}));}catch(error:any){console.log(JSON.stringify({won:false,code:error?.code,message:error?.message}));}`);
    const {leases,records}=ownedLease(dir,{pid,token:'e'.repeat(32),createdAt:Date.now(),processIdentity:'linux:1'});
    const original=(fs as any)[hook].bind(fs);let second:any;
    const spy=spyOn(fs as any,hook).mockImplementation((...args:any[])=>{
      const target=String(args[hook==='linkSync'?1:0]);
      if(!second&&target.includes(marker)&&(hook==='linkSync'||target===records[0]))second=contender(dir,script);
      return original(...args);
    });
    let first:any;
    try{try{first={won:withLock(dir,()=>true)};}catch(error:any){first={won:false,code:error?.code,message:error?.message};}}finally{spy.mockRestore();}
    expect(second).toBeDefined();
    expect([first.won,second.won].filter(Boolean)).toHaveLength(1);
    expect(winner==='first'?first.won:second.won).toBe(true);
    expect((winner==='first'?second:first).code).toBe('INSUFFICIENT_CAPACITY');
    for(const record of records)expect(fs.existsSync(record)).toBe(false);
    expect(fs.readdirSync(leases)).toEqual([]);
  }));
});
