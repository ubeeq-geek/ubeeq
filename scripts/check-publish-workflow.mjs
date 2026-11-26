import {readFile} from 'node:fs/promises';
import {publicPackageInventory,validatePublishSelection} from './public-package-inventory.mjs';
const packages=await publicPackageInventory(),workflow=await readFile('.github/workflows/publish-packages.yml','utf8');
console.log('Publish workflow covers all '+validatePublishSelection(packages,workflow)+' public packages across all workspaces');
