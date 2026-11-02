import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referenceCommerceConfigurationFromEnvironment} from '../dist/index.js';
test('managed hosts can supply their existing mail transport without an HTTP relay',async()=>{
 const sent=[],mail={send:async message=>sent.push(message)};
 const config=referenceCommerceConfigurationFromEnvironment({UBEEQ_COMMERCE_ENABLED:'1',UBEEQ_PAYPAL_ENVIRONMENTS:'sandbox'},mail);
 assert.deepEqual(config.environments,['sandbox']);await config.mail.send({to:'buyer@example.test',subject:'Sign in',text:'test',idempotencyKey:'test'});assert.equal(sent.length,1);
 assert.throws(()=>referenceCommerceConfigurationFromEnvironment({UBEEQ_COMMERCE_ENABLED:'1'}));
 assert.equal(referenceCommerceConfigurationFromEnvironment({},mail),undefined);
});
