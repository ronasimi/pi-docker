import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['index.js',...readdirSync(path.join(root,'lib')).filter(x=>x.endsWith('.js')).sort().map(x=>'lib/'+x)];
const digest=createHash('sha256');
for(const file of files){digest.update(file+'\0');digest.update(readFileSync(path.join(root,file)));}
export const RUNTIME_FINGERPRINT=Object.freeze({version:1,release:'r24',atomicVersion:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version,extensionSha256:digest.digest('hex')});
