import { useState } from 'react';
import { Allocation, RootBlock } from '../lib/model';
import { BatchRequestRow, planBatchAllocation } from '../lib/planner';

interface Props {
  roots: RootBlock[];
  allocations: Allocation[];
  /** 返回错误列表；空数组表示已原子提交 */
  onSubmit: (rows: BatchRequestRow[]) => string[];
  onClose: () => void;
}

interface RowDraft {
  /** 仅用于 React key 的本地 id */
  key: string;
  name: string;
  hostsText: string;
  rootId: string;
  note: string;
}

let rowSeq = 0;
const newRow = (): RowDraft => ({
  key: `row_${++rowSeq}`,
  name: '',
  hostsText: '',
  rootId: 'auto',
  note: '',
});

/**
 * 批量申请弹窗：逐行填写名称 / 主机数 / 根网段（可选）/ 备注，
 * 实时预演每行的最小前缀与最低可用落位；任一行非法或空间不足时禁止提交，
 * 全部通过后由调用方作为一次可撤销修订原子加入。
 */
export default function BatchAllocationModal({ roots, allocations, onSubmit, onClose }: Props) {
  const [drafts, setDrafts] = useState<RowDraft[]>([newRow()]);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);

  const rows: BatchRequestRow[] = drafts.map((d) => ({
    name: d.name,
    hosts: Number(d.hostsText),
    rootId: d.rootId,
    note: d.note,
  }));
  // 每次渲染实时预演：行数少、计算为纯函数，代价可忽略
  const preview = planBatchAllocation(roots, allocations, rows);
  const okCount = preview.items.filter((i) => i.status === 'ok').length;
  const failedCount = preview.items.length - okCount;
  const canSubmit = preview.ok && preview.items.length > 0;

  const update = (key: string, patch: Partial<RowDraft>) => {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    setSubmitErrors([]);
  };
  const removeRow = (key: string) => {
    setDrafts((ds) => ds.filter((d) => d.key !== key));
    setSubmitErrors([]);
  };

  const submit = () => {
    const errs = onSubmit(rows);
    setSubmitErrors(errs);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>批量申请子网</h3>
        <p className="muted">
          逐行填写，系统按输入顺序为每行计算可容纳主机的<strong>最小前缀</strong>，
          并在指定根网段（或全部根网段）中寻找<strong>最低可用地址</strong>；前面的行落位后立即占用空间。
          任一行非法或空间不足时禁止提交且规划不变；全部通过后作为<strong>一次可撤销修订</strong>原子加入。
        </p>

        <div className="table-wrap">
          <table className="batch-table">
            <thead>
              <tr>
                <th>#</th>
                <th>名称</th>
                <th>主机数</th>
                <th>根网段</th>
                <th>备注</th>
                <th>预演结果</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => {
                const item = preview.items[i];
                return (
                  <tr key={d.key} className={item.status === 'failed' ? 'batch-failed' : 'batch-ok'}>
                    <td className="muted">{i + 1}</td>
                    <td>
                      <input
                        value={d.name}
                        onChange={(e) => update(d.key, { name: e.target.value })}
                        placeholder="如 数据中心-C"
                        aria-label={`第 ${i + 1} 行名称`}
                      />
                    </td>
                    <td>
                      <input
                        value={d.hostsText}
                        onChange={(e) => update(d.key, { hostsText: e.target.value })}
                        placeholder="如 500"
                        type="number"
                        min={1}
                        aria-label={`第 ${i + 1} 行主机数`}
                      />
                    </td>
                    <td>
                      <select
                        value={d.rootId}
                        onChange={(e) => update(d.key, { rootId: e.target.value })}
                        aria-label={`第 ${i + 1} 行根网段`}
                      >
                        <option value="auto">自动选择（全部根网段）</option>
                        {roots.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}（{r.cidr}）
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={d.note}
                        onChange={(e) => update(d.key, { note: e.target.value })}
                        placeholder="可选"
                        aria-label={`第 ${i + 1} 行备注`}
                      />
                    </td>
                    <td>
                      {item.status === 'ok' ? (
                        <span className="hint">
                          <code>{item.cidr}</code>（/{item.prefix} · 容量 {item.capacity?.toLocaleString()}）
                        </span>
                      ) : (
                        <span className="batch-reason">{item.reason}</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn small danger"
                        onClick={() => removeRow(d.key)}
                        disabled={drafts.length <= 1}
                        title="删除此行"
                      >
                        删
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="batch-summary">
          <button type="button" className="btn small" onClick={() => setDrafts((ds) => [...ds, newRow()])}>
            + 添加一行
          </button>
          <span className={failedCount > 0 ? 'batch-reason' : 'muted'}>
            共 {preview.items.length} 行 · 可安置 {okCount} 行 · 失败 {failedCount} 行
          </span>
        </div>

        {submitErrors.length > 0 && (
          <ul className="errors">
            {submitErrors.map((er, i) => (
              <li key={i}>{er}</li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canSubmit}
            title={canSubmit ? undefined : '存在非法或无法安置的行，禁止提交'}
            onClick={submit}
          >
            确认并原子加入（{okCount} 个子网）
          </button>
        </div>
      </div>
    </div>
  );
}
