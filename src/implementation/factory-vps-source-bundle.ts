import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile),maxBytes=2*1024*1024,maxFiles=256,maxFileBytes=256*1024;
const forbiddenPath=/(^|\/)(?:\.env(?:\.[^/]*)?|\.git|secrets?|credentials?|backups?|dumps?)(?:\/|$)|\.(?:pem|key|p12|sql|sqlite)$/i;
const secretLike=/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9._-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|amqps):\/\/[^\s:@/]+:[^\s:@/]+@|\b(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN|JWT_SECRET|COOKIE_SECRET|CLIENT_SECRET|DATABASE_URL|REDIS_URL|DASHSCOPE_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i;

/** Builds the portable wire archive from the exact accepted Git tree, never a dirty checkout. */
export async function buildFactoryVpsSourceBundle(repositoryRoot:string,repository:string,expectedSha:string):Promise<Record<string,unknown>> {
  if(!/^[a-f0-9]{40,64}$/i.test(expectedSha))throw new Error("factory_vps_bundle_base_sha_invalid");
  const entries=(await gitText(repositoryRoot,["ls-tree","-r","-z","--full-tree",expectedSha])).split("\0").filter(Boolean);
  if(!entries.length||entries.length>maxFiles)throw new Error("factory_vps_bundle_file_count_invalid");
  const files:Array<{path:string;contentBase64:string;sha256:string}>=[];let expanded=0;
  for(const entry of entries){const match=/^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/i.exec(entry);if(!match)throw new Error("factory_vps_bundle_unsupported_git_entry");const path=match[3]!;if(!safePath(path))throw new Error("factory_vps_bundle_forbidden_path");const content=await gitBuffer(repositoryRoot,["show","--no-ext-diff","--format=",`${expectedSha}:${path}`]);if(content.byteLength>maxFileBytes||content.includes(0))throw new Error("factory_vps_bundle_file_invalid");const text=content.toString("utf8");if(!Buffer.from(text,"utf8").equals(content)||secretLike.test(text))throw new Error("factory_vps_bundle_secret_rejected");expanded+=content.byteLength;if(expanded>maxBytes)throw new Error("factory_vps_bundle_too_large");files.push({path,contentBase64:content.toString("base64"),sha256:digest(content)});}
  files.sort((left,right)=>left.path.localeCompare(right.path));const raw=Buffer.from(JSON.stringify({format:"runforge-source-bundle/v1",files}),"utf8");if(raw.byteLength>maxBytes)throw new Error("factory_vps_bundle_too_large");const sha256=digest(raw);return {mode:"bundle",repository,baseSha:sha256,sha256,bytes:raw.byteLength,encoding:"base64-json-v1",contentBase64:raw.toString("base64"),paths:files.map(file=>file.path)};
}
function safePath(path:string):boolean{return Boolean(path)&&!path.startsWith("/")&&!path.includes("\\")&&!path.split("/").some(part=>!part||part==="."||part==="..")&&!forbiddenPath.test(path)&&!path.split("/").includes(".gitattributes");}
function digest(value:Uint8Array):string{return createHash("sha256").update(value).digest("hex");}
function env():NodeJS.ProcessEnv{return {...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",GIT_ATTR_NOSYSTEM:"1"};}
async function gitText(cwd:string,args:string[]):Promise<string>{return (await execFileAsync("git",args,{cwd,env:env(),maxBuffer:maxBytes+1024*1024})).stdout;}
async function gitBuffer(cwd:string,args:string[]):Promise<Buffer>{return Buffer.from((await execFileAsync("git",args,{cwd,env:env(),encoding:"buffer",maxBuffer:maxFileBytes+1024})).stdout);}
