import { createHash } from 'node:crypto';
import { CommerceError, type PrivateAsset } from '@ubeeq/commerce';
import { createWebsiteZip } from '@ubeeq/portability';
export const packageEntryName = (asset: PrivateAsset) => asset.id + '-' + asset.label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
/** The current portable archive format uses 32-bit offsets. Check before offering a package. */
export function commercePackageSize(assets: readonly PrivateAsset[]) { const size = 22 + assets.reduce((n, a) => n + a.byteLength + 76 + 2 * Buffer.byteLength(packageEntryName(a)), 0); if (assets.length > 65535 || assets.some(a => a.byteLength > 0xffffffff) || size > 0xffffffff)
    throw new CommerceError('package_format_limit', 409); return size; }
/** Reuse the tested STORE-entry writer, retaining only one source file and the small directory. */
export async function* streamCommerceZip(assets: readonly PrivateAsset[], read: (asset: PrivateAsset) => Promise<Uint8Array>, maximum: number): AsyncGenerator<Uint8Array> {
    const size = commercePackageSize(assets);
    if (size > maximum)
        throw new CommerceError('creator_storage_limit', 409);
    let offset = 0;
    const directories: Buffer[] = [];
    for (const asset of [...assets].sort((a, b) => packageEntryName(a) < packageEntryName(b) ? -1 : packageEntryName(a) > packageEntryName(b) ? 1 : 0)) {
        const bytes = await read(asset);
        if (bytes.length !== asset.byteLength || createHash('sha256').update(bytes).digest('hex') !== asset.checksum)
            throw new CommerceError('content_unavailable', 409);
        const single = Buffer.from(createWebsiteZip(new Map([[packageEntryName(asset), bytes]]))), directoryAt = single.readUInt32LE(single.length - 6), directory = Buffer.from(single.subarray(directoryAt, single.length - 22));
        directory.writeUInt32LE(offset, 42);
        directories.push(directory);
        yield single.subarray(0, directoryAt);
        offset += directoryAt;
    }
    const directoryLength = directories.reduce((n, d) => n + d.length, 0);
    for (const directory of directories)
        yield directory;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(assets.length, 8);
    end.writeUInt16LE(assets.length, 10);
    end.writeUInt32LE(directoryLength, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
}
