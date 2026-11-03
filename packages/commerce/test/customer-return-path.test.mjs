import {test} from 'node:test';
import assert from 'node:assert/strict';
import {customerReturnPath} from '../dist/customerReturnPath.js';
test('gift gallery links survive sign-in without allowing mixed resources or unsafe destinations',()=>{
 assert.equal(customerReturnPath('/commerce/purchases?gift=gift-123'),'/commerce/purchases?gift=gift-123');
 for(const path of ['/commerce/purchases?gift=one&purchase=two','/commerce/purchases?gift=one&gift=two','/commerce/purchases?gift=../other','//other.test/commerce/purchases?gift=one'])assert.throws(()=>customerReturnPath(path),{code:'invalid_return_path'});
});
