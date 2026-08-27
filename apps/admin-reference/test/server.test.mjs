import assert from "node:assert/strict";
import test from "node:test";
import { createAdminReferenceApp } from "../src/server.mjs";
test("serves a neutral local operations reference",async(context)=>{const app=createAdminReferenceApp();await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));context.after(()=>app.close());const port=app.address().port;assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(),{status:"ok"});assert.match(await (await fetch(`http://127.0.0.1:${port}/operations`)).text(),/Ubeeq reference operations/);});
