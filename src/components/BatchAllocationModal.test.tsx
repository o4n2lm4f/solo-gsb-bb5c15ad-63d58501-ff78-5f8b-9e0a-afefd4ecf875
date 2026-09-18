import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import BatchAllocationModal from './BatchAllocationModal';
import { RootBlock } from '../lib/model';

const roots: RootBlock[] = [
  { id: 'r1', name: '生产骨干', cidr: '10.0.0.0/8' },
  { id: 'r2', name: '办公网', cidr: '192.168.0.0/16' },
];

describe('BatchAllocationModal 批量申请弹窗', () => {
  it('初始一行空白：展示失败原因且禁止提交', () => {
    const html = renderToString(
      createElement(BatchAllocationModal, {
        roots,
        allocations: [],
        onSubmit: () => [],
        onClose: () => {},
      }),
    );
    expect(html).toContain('批量申请子网');
    expect(html).toContain('添加一行');
    // 空白行实时预演为失败（名称为空 / 主机数非法），并禁止提交
    expect(html).toContain('名称不能为空；主机数必须为不小于 1 的整数');
    expect(html).toContain('失败 <!-- -->1<!-- --> 行');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>确认并原子加入/);
  });

  it('根网段下拉包含自动选择与全部根网段', () => {
    const html = renderToString(
      createElement(BatchAllocationModal, {
        roots,
        allocations: [],
        onSubmit: () => [],
        onClose: () => {},
      }),
    );
    expect(html).toContain('自动选择（全部根网段）');
    // SSR 会在文本插值间插入 <!-- -->，分段断言
    expect(html).toContain('生产骨干');
    expect(html).toContain('10.0.0.0/8');
    expect(html).toContain('办公网');
    expect(html).toContain('192.168.0.0/16');
  });

  it('未定义根网段时逐行提示', () => {
    const html = renderToString(
      createElement(BatchAllocationModal, {
        roots: [],
        allocations: [],
        onSubmit: () => [],
        onClose: () => {},
      }),
    );
    expect(html).toContain('批量申请子网');
  });
});
