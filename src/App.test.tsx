import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import App from './App';
import BatchApplyModal from './components/BatchApplyModal';
import { Plan } from './lib/model';

describe('App 冒烟测试', () => {
  it('组件树可整体渲染', () => {
    const html = renderToString(createElement(App));
    expect(html).toContain('IPv4 子网规划台');
    expect(html).toContain('根网段');
    expect(html).toContain('地址空间树');
    expect(html).toContain('新建分配');
    expect(html).toContain('批量申请');
    expect(html).toContain('前缀策略校验');
    expect(html).toContain('加密导出');
    expect(html).toContain('加密导入');
  });
});

describe('BatchApplyModal 冒烟测试', () => {
  const plan: Plan = {
    version: 1,
    roots: [{ id: 'r1', name: '生产', cidr: '10.0.0.0/24' }],
    allocations: [],
  };

  it('弹窗渲染行编辑表格与禁止提交的初始状态', () => {
    const html = renderToString(
      createElement(BatchApplyModal, {
        plan,
        onSubmit: () => [],
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('批量申请子网');
    expect(html).toContain('空行忽略');
    expect(html).toContain('尚未填写有效行');
    // 初始无有效行：提交按钮禁用
    expect(html).toMatch(/disabled[^>]*>\s*提交批量申请/);
  });
});
