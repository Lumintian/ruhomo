#!/usr/bin/env node
/** Hooks for `pnpm version`: pnpm commits and tags; postversion pushes both refs. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function assertReleaseCheckout() {
  if (git('symbolic-ref', '--quiet', '--short', 'HEAD') !== 'main') {
    throw new Error('仅允许在 main 分支运行 pnpm version');
  }
  if (git('status', '--porcelain')) {
    throw new Error('工作区必须干净：先提交或移走未提交的改动');
  }
}

function beforeVersion() {
  assertReleaseCheckout();
  const remoteMain = git('ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (!remoteMain) throw new Error('origin/main 不存在：请先推送 main');
  if (spawnSync('git', ['merge-base', '--is-ancestor', remoteMain, 'HEAD']).status !== 0) {
    throw new Error('本地 main 未包含远端 main：请先同步远端改动');
  }
}

function afterVersion() {
  assertReleaseCheckout();
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tag = `v${version}`;
  if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag' || git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD')) {
    throw new Error(`本地标签 ${tag} 必须是指向当前版本提交的附注标签`);
  }
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
    throw new Error(`远端标签 ${tag} 已存在，不会重复发布`);
  }
  // Either the version commit and its tag arrive together, or neither does.
  execFileSync('git', ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`], { stdio: 'inherit' });
  console.log(`已推送 main 和 ${tag}；等待 GitHub Actions 检查后部署`);
}

try {
  if (process.argv[2] === 'pre') beforeVersion();
  else if (process.argv[2] === 'post') afterVersion();
  else throw new Error('usage: release-version.mjs pre|post');
} catch (error) {
  console.error(`[release] ${error.message}`);
  process.exitCode = 1;
}
