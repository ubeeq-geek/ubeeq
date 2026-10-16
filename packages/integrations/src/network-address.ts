import { isIP, BlockList } from 'node:net';

const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) nonPublicV4.addSubnet(address, prefix, 'ipv4');
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  nonPublicV6.addSubnet(address, prefix, 'ipv6');

export const isNonPublicIntegrationAddress = (address: string): boolean => {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(value);
  if (family === 4) return nonPublicV4.check(value, 'ipv4');
  // Only global unicast IPv6, excluding transition/documentation ranges.
  // This also rejects IPv4-mapped loopback/private addresses.
  if (family === 6) return !/^[23][0-9a-f]{3}:/.test(value) || nonPublicV6.check(value, 'ipv6');
  return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || !value.includes('.');
};

