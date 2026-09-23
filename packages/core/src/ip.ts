/**
 * Strict IP prefix validation modelled on Go's netip.ParsePrefix, which
 * Mihomo uses for IP-CIDR/IP-CIDR6/SRC-IP-CIDR/IP-SUFFIX/SRC-IP-SUFFIX.
 * Returns an error message, or undefined when the prefix is valid.
 */

function checkIPv4(s: string): string | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return 'IPv4 地址必须是四段点分十进制';
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return `IPv4 段 "${p}" 无效`;
    if (p.length > 1 && p.startsWith('0')) return `IPv4 段 "${p}" 含前导零`;
    if (Number(p) > 255) return `IPv4 段 "${p}" 超出 0-255`;
  }
  return undefined;
}

function checkIPv6(s: string): string | undefined {
  if (s.includes('%')) return 'IPv6 前缀不能包含 zone（%）';
  let head = s;
  let v4Groups = 0;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const err = checkIPv4(tail);
    if (err) return err;
    head = s.slice(0, lastColon + 1);
    // "::1.2.3.4" keeps the "::"; "a:b::c:1.2.3.4" becomes "a:b::c:" -> strip the lone colon.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
    v4Groups = 2;
  }
  const dbl = head.indexOf('::');
  if (dbl !== head.lastIndexOf('::') || head.includes(':::')) return 'IPv6 地址中 "::" 只能出现一次';
  const groupsOf = (part: string): string[] | undefined => (part === '' ? [] : part.split(':'));
  let groups: string[];
  if (dbl >= 0) {
    const left = groupsOf(head.slice(0, dbl));
    const right = groupsOf(head.slice(dbl + 2));
    if (!left || !right) return 'IPv6 地址格式无效';
    groups = [...left, ...right];
    if (groups.length + v4Groups >= 8) return 'IPv6 地址中 "::" 至少要代表一组';
  } else {
    groups = head.split(':');
    if (groups.length + v4Groups !== 8) return 'IPv6 地址必须有 8 组';
  }
  for (const g of groups) {
    if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return `IPv6 组 "${g}" 无效`;
  }
  return undefined;
}

export function checkPrefix(s: string): string | undefined {
  const slash = s.lastIndexOf('/');
  if (slash < 0) return '缺少前缀长度（如 /24）';
  const addr = s.slice(0, slash);
  const bits = s.slice(slash + 1);
  if (!/^(0|[1-9]\d{0,2})$/.test(bits)) return `前缀长度 "${bits}" 无效`;
  const n = Number(bits);
  if (addr.includes(':')) {
    const err = checkIPv6(addr);
    if (err) return err;
    if (n > 128) return 'IPv6 前缀长度不能超过 128';
  } else {
    const err = checkIPv4(addr);
    if (err) return err;
    if (n > 32) return 'IPv4 前缀长度不能超过 32';
  }
  return undefined;
}
