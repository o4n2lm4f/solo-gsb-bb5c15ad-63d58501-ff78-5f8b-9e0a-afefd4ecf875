/**
 * 规划引擎：空闲块查找、最低可用地址分配、迁移预演、地址空间树。
 */
import {
  Cidr,
  alignUp,
  blockSize,
  cidrToString,
  compareCidr,
  contains,
  freeBlocks,
  isAlignedCidr,
  overlaps,
  parseCidr,
  prefixForHosts,
  usableHosts,
} from './ip';
import { Allocation, RootBlock } from './model';

/**
 * 在 roots（按地址升序扫描）中寻找可容纳 /prefix 的最低可用地址。
 * occupied 为已占用块。找到即返回对齐后的 CIDR，找不到返回 null。
 */
export function findLowestSlot(
  roots: Cidr[],
  occupied: Cidr[],
  prefix: number,
): Cidr | null {
  const size = blockSize(prefix);
  const sortedRoots = [...roots].sort((a, b) => a.base - b.base);
  for (const root of sortedRoots) {
    for (const free of freeBlocks(root, occupied)) {
      const start = alignUp(free.base, prefix);
      if (start + size <= free.base + blockSize(free.prefix)) {
        return { base: start, prefix };
      }
    }
  }
  return null;
}

export type MigrationStatus = 'kept' | 'moved' | 'failed';

/** 批量申请的一行输入（rootId 为 'auto' 时在全部根网段中寻找） */
export interface BatchRequestRow {
  name: string;
  hosts: number;
  rootId: string;
  note: string;
}

export interface BatchPlanItem {
  /** 输入顺序下标（0 基） */
  index: number;
  name: string;
  hosts: number;
  rootId: string;
  note: string;
  /** 最小前缀；输入非法时为 null */
  prefix: number | null;
  /** 可用主机容量；prefix 非法时为 null */
  capacity: number | null;
  /** 拟落位（规范化 CIDR）；失败时为 null */
  cidr: string | null;
  status: 'ok' | 'failed';
  reason?: string;
}

export interface BatchPlan {
  items: BatchPlanItem[];
  /** 全部行可安置（无 failed）时才允许提交 */
  ok: boolean;
}

/**
 * 批量申请预演（纯函数，不产生副作用）：
 * 按输入顺序逐行处理——为每行计算可容纳主机的最小前缀，
 * 在指定根网段（或全部根网段，按地址升序）中寻找最低可用地址；
 * 成功行立即占用空间，后续行看到的是前面行落位后的剩余空间；
 * 失败行不占用空间、不阻断后续行预演，但整批 ok = false（调用方禁止提交）。
 */
export function planBatchAllocation(
  roots: RootBlock[],
  existing: Allocation[],
  rows: BatchRequestRow[],
): BatchPlan {
  const allRoots = roots
    .map((r) => ({ root: r, cidr: parseCidr(r.cidr) }))
    .filter((x): x is { root: RootBlock; cidr: Cidr } => x.cidr !== null)
    .sort((a, b) => a.cidr.base - b.cidr.base);

  const occupied: Cidr[] = existing
    .map((a) => parseCidr(a.cidr))
    .filter((c): c is Cidr => c !== null)
    .sort(compareCidr);

  const items: BatchPlanItem[] = rows.map((row, index) => {
    const item: BatchPlanItem = {
      index,
      name: row.name,
      hosts: row.hosts,
      rootId: row.rootId,
      note: row.note,
      prefix: null,
      capacity: null,
      cidr: null,
      status: 'failed',
    };
    const errors: string[] = [];
    if (!row.name.trim()) errors.push('名称不能为空');
    if (!Number.isInteger(row.hosts) || row.hosts < 1) {
      errors.push('主机数必须为不小于 1 的整数');
    }
    if (errors.length > 0) {
      item.reason = errors.join('；');
      return item;
    }

    const prefix = prefixForHosts(row.hosts);
    item.prefix = prefix;
    item.capacity = usableHosts(prefix);

    if (allRoots.length === 0) {
      item.reason = '尚未定义任何根网段';
      return item;
    }
    const scoped =
      row.rootId === 'auto'
        ? allRoots
        : allRoots.filter((r) => r.root.id === row.rootId);
    if (scoped.length === 0) {
      item.reason = '指定的根网段不存在';
      return item;
    }

    const slot = findLowestSlot(scoped.map((r) => r.cidr), occupied, prefix);
    if (!slot) {
      const scope =
        row.rootId === 'auto'
          ? '全部根网段'
          : `根网段「${scoped[0].root.name}」`;
      item.reason = `地址空间不足：${scope}中没有可容纳 ${row.hosts} 台主机（/${prefix}）的空闲块`;
      return item;
    }

    occupied.push(slot);
    occupied.sort(compareCidr);
    item.cidr = cidrToString(slot);
    item.status = 'ok';
    return item;
  });

  return { items, ok: items.every((i) => i.status === 'ok') };
}

export interface MigrationItem {
  allocId: string;
  name: string;
  kind: Allocation['kind'];
  prefix: number;
  /** 原落位 */
  from: string;
  /** 新落位；failed 时为 null */
  to: string | null;
  status: MigrationStatus;
  reason?: string;
}

export interface MigrationPlan {
  items: MigrationItem[];
  /** 全部可安置（无 failed）时才允许确认 */
  ok: boolean;
}

/**
 * 迁移预演（纯函数，不产生副作用）：
 *  - 可保留项：容量未变、落位仍对齐且位于新根网段内、且与其他保留项不重叠 → 原位不动；
 *  - 其余项按网段从大到小（前缀升序）、原地址升序，安置到最低可用地址；
 *  - 任一无法安置 → ok = false（调用方禁止确认）。
 *
 * @param nextRoots 调整后的根网段
 * @param nextAllocs 调整后的分配（prefix 为期望容量，cidr 为当前落位）
 */
export function planMigration(
  nextRoots: RootBlock[],
  nextAllocs: Allocation[],
): MigrationPlan {
  const roots = nextRoots
    .map((r) => parseCidr(r.cidr))
    .filter((c): c is Cidr => c !== null)
    .sort((a, b) => a.base - b.base);

  const items: MigrationItem[] = [];
  const keptCidrs: Cidr[] = [];
  const movers: { alloc: Allocation; cidr: Cidr | null }[] = [];

  for (const alloc of nextAllocs) {
    const cur = parseCidr(alloc.cidr);
    const keepable =
      cur !== null &&
      cur.prefix === alloc.prefix &&
      isAlignedCidr(alloc.cidr) &&
      roots.some((r) => contains(r, cur)) &&
      !keptCidrs.some((k) => overlaps(k, cur));
    if (keepable && cur) {
      keptCidrs.push(cur);
      items.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: alloc.cidr,
        status: 'kept',
      });
    } else {
      movers.push({ alloc, cidr: cur });
    }
  }

  // 网段从大到小（前缀小者优先），同容量按原地址升序，再按名称保证稳定
  movers.sort((a, b) => {
    if (a.alloc.prefix !== b.alloc.prefix) return a.alloc.prefix - b.alloc.prefix;
    const ab = a.cidr ? a.cidr.base : Number.MAX_SAFE_INTEGER;
    const bb = b.cidr ? b.cidr.base : Number.MAX_SAFE_INTEGER;
    if (ab !== bb) return ab - bb;
    return a.alloc.name.localeCompare(b.alloc.name);
  });

  const occupied = [...keptCidrs];
  const movedItems: MigrationItem[] = [];
  for (const { alloc, cidr } of movers) {
    const slot = findLowestSlot(roots, occupied, alloc.prefix);
    if (slot) {
      occupied.push(slot);
      occupied.sort(compareCidr);
      movedItems.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: cidrToString(slot),
        status: 'moved',
      });
    } else {
      movedItems.push({
        allocId: alloc.id,
        name: alloc.name,
        kind: alloc.kind,
        prefix: alloc.prefix,
        from: alloc.cidr,
        to: null,
        status: 'failed',
        reason: cidr
          ? '地址空间不足：没有可容纳该网段的空闲块'
          : `原落位 ${alloc.cidr} 非法，且地址空间不足`,
      });
    }
  }

  // 输出顺序：保留项按原地址升序，迁移/失败项按安置顺序
  const all = [...items, ...movedItems];
  return { items: all, ok: movedItems.every((i) => i.status !== 'failed') };
}

/** 应用迁移结果，返回更新后的分配数组（整批原子替换由调用方提交）。 */
export function applyMigration(
  allocs: Allocation[],
  plan: MigrationPlan,
): Allocation[] {
  const byId = new Map(plan.items.map((i) => [i.allocId, i]));
  return allocs.map((a) => {
    const item = byId.get(a.id);
    if (!item || item.to === null) return a;
    return { ...a, cidr: item.to };
  });
}

/** 地址空间树节点 */
export interface TreeNode {
  cidr: Cidr;
  key: string;
  depth: number;
  status: 'free' | 'allocated' | 'partial';
  alloc?: Allocation;
  children?: [TreeNode, TreeNode];
}

/** 构建某个根网段的地址空间树：空闲伙伴块天然合并为叶子，含分配的子树继续二分。 */
export function buildTree(
  root: Cidr,
  allocs: { alloc: Allocation; cidr: Cidr }[],
  depth = 0,
): TreeNode {
  const key = cidrToString(root);
  const inside = allocs.filter(({ cidr }) => contains(root, cidr));
  const exact = inside.find(({ cidr }) => cidr.base === root.base && cidr.prefix === root.prefix);
  if (exact) {
    return { cidr: root, key, depth, status: 'allocated', alloc: exact.alloc };
  }
  if (inside.length === 0) {
    return { cidr: root, key, depth, status: 'free' };
  }
  if (root.prefix >= 32) {
    // 理论不可达：/32 若有分配必然 exact
    return { cidr: root, key, depth, status: 'free' };
  }
  const childPrefix = root.prefix + 1;
  const half = blockSize(childPrefix);
  const low = buildTree({ base: root.base, prefix: childPrefix }, inside, depth + 1);
  const high = buildTree({ base: root.base + half, prefix: childPrefix }, inside, depth + 1);
  return { cidr: root, key, depth, status: 'partial', children: [low, high] };
}
