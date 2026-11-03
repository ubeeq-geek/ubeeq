import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commerceDownloadFilename} from '../dist/download-filename.js';

test('download display titles receive the extension matching their actual content type',()=>{
  assert.equal(commerceDownloadFilename('A collection image','image/jpeg'),'A_collection_image.jpg');
  assert.equal(commerceDownloadFilename('Collection download','application/zip'),'Collection_download.zip');
  assert.equal(commerceDownloadFilename('Part One.2','image/png'),'Part_One.2.png');
  assert.equal(commerceDownloadFilename('photo.JPEG','image/jpeg'),'photo.JPEG');
  assert.equal(commerceDownloadFilename('archive.zip','application/zip'),'archive.zip');
  assert.equal(commerceDownloadFilename('photo','IMAGE/WEBP; charset=binary'),'photo.webp');
});
test('download filenames stay safe and retain the extension after truncation',()=>{
  const name=commerceDownloadFilename('a'.repeat(200)+'.png','image/png');
  assert.equal(name.length,150);assert.ok(name.endsWith('.png'));
  assert.equal(commerceDownloadFilename('..','application/zip'),'download.zip');
  assert.doesNotMatch(commerceDownloadFilename('bad"\r\n/title','image/png'),/["\r\n/]/);
});
