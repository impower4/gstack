import { describe, expect, test } from 'bun:test';
import type { HttpAssertion } from '../lib/cso/contracts';
import { boundedResponseBody, judgeSecurity } from '../lib/cso/verifier';

describe('CSO bounded loopback verifier response reader',()=>{
  test('accepts a response exactly at the configured byte limit',async()=>{
    const body='x'.repeat(65_536);
    expect(await boundedResponseBody(new Response(body))).toBe(body);
  });

  test('cancels an endless chunked response immediately after the byte limit',async()=>{
    let pulls=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({
      pull(controller){pulls++;controller.enqueue(new Uint8Array(8192));},
      cancel(){cancelled=true;},
    });
    await expect(boundedResponseBody(new Response(stream))).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
  });

  test('rejects an oversized declared body before consuming it',async()=>{
    let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
    const response=new Response(stream,{headers:{'content-length':'65537'}});
    await expect(boundedResponseBody(response)).rejects.toThrow('response too large');
    expect(cancelled).toBe(true);
  });
});

describe('CSO verifier security judgement',()=>{
  const payloads:HttpAssertion[]=[
    {name:'id parameter',path:'/user?id=2',method:'GET',expected:{status:403},vulnerable:{status:200,includes:'tenant-b'}},
    {name:'tenant header',path:'/user',method:'GET',headers:{'x-tenant':'b'},expected:{status:403},vulnerable:{status:200,includes:'tenant-b'}},
    {name:'write path',path:'/user/2',method:'PUT',body:'{}',expected:{status:404},vulnerable:{status:204}},
  ];
  const serve=(fixed:Set<string>)=>{
    const seen:string[]=[];
    const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch(req){
      const url=new URL(req.url),key=`${req.method} ${url.pathname}${url.search}`;seen.push(key);
      if(req.method==='PUT')return new Response(null,{status:fixed.has(key)?404:204});
      return fixed.has(key)?new Response('denied',{status:403}):new Response('tenant-b secret',{status:200});
    }});
    return {server,seen,port:Number(server.port)};
  };
  const ALL=new Set(['GET /user?id=2','GET /user','PUT /user/2']);

  test('one booted server answers every array member and the before phase needs every vulnerable expectation',async()=>{
    const {server,seen,port}=serve(new Set());
    try{
      expect(await judgeSecurity('before',payloads,port)).toEqual({security:'intended_failure',members:['intended_failure','intended_failure','intended_failure']});
      expect(seen).toEqual(['GET /user?id=2','GET /user','PUT /user/2']);
    }finally{server.stop(true);}
  });

  test('the after phase passes only when every array member passes its fixed expectation',async()=>{
    const fixed=serve(ALL);
    try{expect(await judgeSecurity('after',payloads,fixed.port)).toEqual({security:'pass',members:['pass','pass','pass']});}finally{fixed.server.stop(true);}
    const partial=serve(new Set(['GET /user?id=2','PUT /user/2']));
    try{
      expect(await judgeSecurity('after',payloads,partial.port)).toEqual({security:'inconclusive',members:['pass','inconclusive','pass']});
      expect(await judgeSecurity('before',payloads,partial.port)).toEqual({security:'inconclusive',members:['pass','intended_failure','pass']});
    }finally{partial.server.stop(true);}
    const disproved=serve(ALL);
    try{expect((await judgeSecurity('before',payloads,disproved.port)).security).toBe('pass');}finally{disproved.server.stop(true);}
  });

  test('a set of safe statuses passes any listed rejection that withholds the marker and nothing else',async()=>{
    const dotfile:HttpAssertion={name:'dotfile',path:'/.env',method:'GET',expected:{status:[403,404],excludes:'DOTFILE'},vulnerable:{status:200,includes:'DOTFILE'}};
    const answer=async(status:number,body:string)=>{
      const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response(body,{status})});
      try{return [(await judgeSecurity('before',dotfile,Number(server.port))).security,(await judgeSecurity('after',dotfile,Number(server.port))).security];}finally{server.stop(true);}
    };
    expect(await answer(404,'not found')).toEqual(['pass','pass']);
    expect(await answer(403,'denied')).toEqual(['pass','pass']);
    expect(await answer(200,'DOTFILE=1')).toEqual(['intended_failure','inconclusive']);
    expect(await answer(403,'denied DOTFILE=1')).toEqual(['inconclusive','inconclusive']);
    expect(await answer(400,'bad request')).toEqual(['inconclusive','inconclusive']);
  });

  test('a single assertion keeps its original before and after outcomes',async()=>{
    const vulnerable=serve(new Set()),fixed=serve(ALL);
    try{
      expect(await judgeSecurity('before',payloads[0],vulnerable.port)).toEqual({security:'intended_failure',members:['intended_failure']});
      expect(await judgeSecurity('after',payloads[0],vulnerable.port)).toEqual({security:'inconclusive',members:['inconclusive']});
      expect(await judgeSecurity('after',payloads[0],fixed.port)).toEqual({security:'pass',members:['pass']});
    }finally{vulnerable.server.stop(true);fixed.server.stop(true);}
  });
});
