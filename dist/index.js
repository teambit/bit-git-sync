// git-sync/git-sync/action/run.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// node_modules/@bitdev/git-sync.git-sync.event-router/dist/event-router.js
var BIT_SYNC_COMMIT_MARKER = "[bit-sync]";
function run(...args) {
  return { kind: "run", args };
}
function skip(reason) {
  return { kind: "skip", reason };
}
function branchFromRef(ref) {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}
var VALID_LANE_NAME = /^[A-Za-z0-9._-]+$/;
var VALID_SCOPE_NAME = /^[A-Za-z0-9._-]+$/;
function runSyncLane(lane, source) {
  if (!VALID_LANE_NAME.test(lane) || lane.startsWith("-")) {
    return skip(`invalid lane name from ${source}: ${JSON.stringify(lane)}`);
  }
  return run("sync", lane);
}
function runSyncLaneId(laneId, source) {
  const idx = laneId.indexOf("/");
  if (idx === -1)
    return runSyncLane(laneId, source);
  const scopePart = laneId.slice(0, idx);
  const namePart = laneId.slice(idx + 1);
  if (!VALID_SCOPE_NAME.test(scopePart) || scopePart.startsWith("-")) {
    return skip(`invalid lane scope from ${source}: ${JSON.stringify(scopePart)}`);
  }
  if (!VALID_LANE_NAME.test(namePart) || namePart.startsWith("-")) {
    return skip(`invalid lane name from ${source}: ${JSON.stringify(namePart)}`);
  }
  return run("sync", laneId);
}
function scopesInComponentIds(componentIds) {
  return componentIds.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => {
    const idx = entry.indexOf("/");
    return idx === -1 ? entry : entry.slice(0, idx);
  });
}
function isLaneRelevantToScope(componentIds, repoScope) {
  if (!componentIds || !repoScope)
    return true;
  const scopes = scopesInComponentIds(componentIds);
  if (scopes.length === 0)
    return true;
  return scopes.includes(repoScope);
}
function routeRepositoryDispatch(input) {
  const { dispatchType, clientPayload, repoScope } = input;
  switch (dispatchType) {
    // Real bit.cloud webhook contract (empirically verified): a single
    // 'bit-export' dispatch type, discriminated by clientPayload.laneId.
    case "bit-export": {
      if (!isLaneRelevantToScope(clientPayload?.componentIds, repoScope)) {
        return skip(`lane does not touch this repo's scope (${repoScope})`);
      }
      const laneId = clientPayload?.laneId;
      if (laneId)
        return runSyncLaneId(laneId, "client_payload.laneId");
      return run("sync", "--main");
    }
    // Forward-compat aliases: kept in case a platform/webhook config still
    // sends the originally-assumed, more granular dispatch types.
    case "bit-lane-export":
    case "bit-lane-removed": {
      const lane = clientPayload?.lane;
      if (!lane)
        return skip(`repository_dispatch '${dispatchType}' missing clientPayload.lane`);
      return runSyncLane(lane, "client_payload.lane");
    }
    case "bit-main-export":
      return run("sync", "--main");
    default:
      return skip(`unrecognized repository_dispatch type: ${dispatchType ?? "<none>"}`);
  }
}
function routePush(input) {
  const { ref, headCommitMessage, defaultBranch, mainSyncBranch } = input;
  if (!ref)
    return skip("push event missing ref");
  const branch = branchFromRef(ref);
  if (headCommitMessage?.includes(BIT_SYNC_COMMIT_MARKER)) {
    return skip("push is one of bit-sync own commits");
  }
  if (branch === defaultBranch) {
    return skip(`push to default branch '${defaultBranch}'`);
  }
  if (branch === mainSyncBranch) {
    return skip(`push to main sync branch '${mainSyncBranch}'`);
  }
  return run("sync", "--branch", branch);
}
function routePullRequest(input) {
  const { prMerged, prHeadRef, baseRef, defaultBranch, mainSyncBranch } = input;
  if (!prMerged)
    return skip("pull_request closed without merging");
  if (prHeadRef === mainSyncBranch) {
    return skip("merged main-sync PR: nothing to release, scope is already ahead");
  }
  if (baseRef !== void 0 && baseRef !== defaultBranch) {
    return skip(`merged PR targets '${baseRef}', not the default branch '${defaultBranch}'`);
  }
  return run("merge");
}
function routeWorkflowDispatch(input) {
  return input.inputLane ? runSyncLaneId(input.inputLane, "workflow_dispatch input") : run("sync", "--all");
}
function routeEvent(input) {
  switch (input.eventName) {
    case "repository_dispatch":
      return routeRepositoryDispatch(input);
    case "push":
      return routePush(input);
    case "pull_request":
      return routePullRequest(input);
    case "workflow_dispatch":
      return routeWorkflowDispatch(input);
    case "schedule":
      return run("sync", "--all");
    default:
      return skip(`unrecognized event: ${input.eventName}`);
  }
}

// git-sync/git-sync/action/action.ts
var DEFAULT_WS_DIR = ".";
var DEFAULT_MAIN_SYNC_BRANCH = "bit-sync/main";
var DEFAULT_BRANCH_FALLBACK = "main";
var DEFAULT_GIT_USER_NAME = "bit-sync[bot]";
var DEFAULT_GIT_USER_EMAIL = "bit-sync[bot]@users.noreply.github.com";
function forLog(value) {
  return String(value).replace(/[\r\n\u2028\u2029]/g, " ");
}
var DEFAULT_SCOPE_REGEX = /"defaultScope"\s*:\s*"([^"]+)"/;
function readDefaultScope(readTextFile2) {
  if (!readTextFile2) return void 0;
  try {
    const text = readTextFile2("workspace.jsonc");
    return text.match(DEFAULT_SCOPE_REGEX)?.[1];
  } catch {
    return void 0;
  }
}
function buildRouterInput(env, readEventFile2, readTextFile2) {
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const eventPath = env.GITHUB_EVENT_PATH;
  const payload = eventPath ? readEventFile2(eventPath) : {};
  const mainSyncBranch = env["INPUT_MAIN-SYNC-BRANCH"] || DEFAULT_MAIN_SYNC_BRANCH;
  const defaultBranch = payload?.repository?.default_branch ?? DEFAULT_BRANCH_FALLBACK;
  const input = {
    eventName,
    defaultBranch,
    mainSyncBranch,
    repoScope: readDefaultScope(readTextFile2)
  };
  switch (eventName) {
    case "repository_dispatch":
      input.dispatchType = payload?.action;
      input.clientPayload = payload?.client_payload;
      break;
    case "push":
      input.ref = payload?.ref;
      input.headCommitMessage = payload?.head_commit?.message;
      break;
    case "pull_request":
      input.prMerged = payload?.pull_request?.merged;
      input.prHeadRef = payload?.pull_request?.head?.ref;
      input.baseRef = payload?.pull_request?.base?.ref;
      break;
    case "workflow_dispatch":
      input.inputLane = payload?.inputs?.lane;
      break;
    default:
      break;
  }
  return input;
}
async function runAction(deps) {
  const { env, readEventFile: readEventFile2, exec: exec2, chdir = (dir) => process.chdir(dir), readTextFile: readTextFile2 } = deps;
  const wsDir = env["INPUT_WS-DIR"] || DEFAULT_WS_DIR;
  if (wsDir && wsDir !== ".") {
    chdir(wsDir);
  }
  const routerInput = buildRouterInput(env, readEventFile2, readTextFile2);
  const routed = routeEvent(routerInput);
  if (routed.kind === "skip") {
    console.log(`[bit-git-sync] skipping: ${forLog(routed.reason)}`);
    return 0;
  }
  const gitUserName = env.GIT_USER_NAME || DEFAULT_GIT_USER_NAME;
  const gitUserEmail = env.GIT_USER_EMAIL || DEFAULT_GIT_USER_EMAIL;
  await exec2("git", ["config", "user.name", gitUserName]);
  await exec2("git", ["config", "user.email", gitUserEmail]);
  return exec2("bit", ["ci", ...routed.args, "--log", "info"]);
}

// git-sync/git-sync/action/run.ts
function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
function readEventFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function readTextFile(path) {
  return readFileSync(path, "utf8");
}
runAction({ env: process.env, readEventFile, readTextFile, exec, chdir: (dir) => process.chdir(dir) }).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
