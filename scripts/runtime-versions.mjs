import fs from 'node:fs/promises';
import path from 'node:path';
import {findPackageJSON} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const RUNTIME_ROOT=process.env.PI_RUNTIME_ROOT||'/opt/pi-runtime';
const adjacent=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime/versions.json');
const expected=await fs.readFile(process.env.PI_VERSIONS_FILE||adjacent,'utf8').catch(error=>{
  if(error.code!=='ENOENT')throw error;
  return fs.readFile(path.join(RUNTIME_ROOT,'versions.json'),'utf8');
});
export const VERSIONS=JSON.parse(expected);
export function sdkOrigin(webRoot) {
  const packageFile=findPackageJSON('@earendil-works/pi-coding-agent',pathToFileURL(path.join(webRoot,'package.json')));
  if(!packageFile)throw new Error('Web UI cannot resolve the shared Pi SDK');
  return path.dirname(packageFile);
}
