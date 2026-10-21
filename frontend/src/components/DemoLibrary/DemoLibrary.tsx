/**
 * DemoLibrary — lists previously parsed demos stored in the backend cache.
 * Supports loading, single delete, and bulk delete via checkboxes. Demos parsed
 * by an older parser version are tagged "outdated" and can be updated in place
 * (re-parsed from the file the server kept).
 */

import React, { useEffect, useState } from 'react';
import { listDemos, deleteDemo } from '../../utils/api';
import { reparseAndWait } from '../../utils/demoLoading';
import { apiErrorMessage } from '../../utils/highlights';
import type { DemoMeta } from '../../types';
import styles from './DemoLibrary.module.css';

function formatBytes(bytes?: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  onLoad: (demoId: string) => void;
}

const DemoLibrary: React.FC<Props> = ({ onLoad }) => {
  const [demos, setDemos]       = useState<DemoMeta[]>([]);
  const [loading, setLoading]   = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** demo id → re-parse progress (0..1), or an error message if it failed. */
  const [updating, setUpdating] = useState<Record<string, number | string>>({});

  useEffect(() => {
    listDemos()
      .then((d) => setDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))))
      .catch(() => setDemos([]))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allSelected = demos.length > 0 && selected.size === demos.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(demos.map((d) => d.id)));
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} demo(s) from the cache?`)) return;
    setDeleting(true);
    const ids = Array.from(selected);
    await Promise.allSettled(
      ids.map(async (id) => {
        await deleteDemo(id);
        setDemos((prev) => prev.filter((d) => d.id !== id));
        setSelected((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }),
    );
    setDeleting(false);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this demo from the cache?')) return;
    setDeleting(true);
    try {
      await deleteDemo(id);
      setDemos((prev) => prev.filter((d) => d.id !== id));
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } finally {
      setDeleting(false);
    }
  };

  const handleUpdate = async (d: DemoMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setUpdating((u) => ({ ...u, [d.id]: 0 }));
    try {
      await reparseAndWait(d.id, {
        onParseStatus: (st) => setUpdating((u) => ({ ...u, [d.id]: st.progress })),
      });
      setDemos((prev) => prev.map((x) => (x.id === d.id ? { ...x, outdated: false } : x)));
      setUpdating((u) => { const n = { ...u }; delete n[d.id]; return n; });
    } catch (err) {
      setUpdating((u) => ({ ...u, [d.id]: apiErrorMessage(err, 'Update failed') }));
    }
  };

  if (loading) return <p className={styles.hint}>Loading library…</p>;
  if (demos.length === 0) return <p className={styles.hint}>No cached demos yet.</p>;

  return (
    <div className={styles.root}>
      <div className={styles.bulkBar}>
        <label className={styles.selectAllLabel}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
          />
          All
        </label>
        {selected.size > 0 && (
          <button
            className={styles.bulkDeleteBtn}
            onClick={handleBulkDelete}
            disabled={deleting}
          >
            {deleting ? '…' : `Delete (${selected.size})`}
          </button>
        )}
      </div>
      {demos.map((d) => {
        const upd = updating[d.id];
        const busy = typeof upd === 'number';
        return (
        <div
          key={d.id}
          className={`${styles.row} ${selected.has(d.id) ? styles.rowSelected : ''}`}
          // Loading mid-update would show the old data — wait for it.
          onClick={() => { if (!busy) onLoad(d.id); }}
          title={busy ? 'Updating…' : `Click to load ${d.filename}`}
        >
          <input
            type="checkbox"
            className={styles.rowCheck}
            checked={selected.has(d.id)}
            onChange={() => {}}
            onClick={(e) => toggleSelect(d.id, e)}
          />
          <div className={styles.info}>
            <span className={styles.name}>{d.filename}</span>
            <span className={styles.meta}>
              {d.map_name} · {formatBytes(d.file_size)} · {d.tick_rate.toFixed(0)} tick
            </span>
            {typeof upd === 'string' && <span className={styles.updateError}>{upd}</span>}
          </div>
          {d.outdated && (
            d.reparsable ? (
              <button
                className={styles.updateBtn}
                onClick={(e) => handleUpdate(d, e)}
                disabled={busy}
                title="Parsed by an older version of the app — re-parse it to pick up recent fixes"
              >
                {busy ? `Updating ${Math.round((upd as number) * 100)}%` : 'Update'}
              </button>
            ) : (
              <span
                className={styles.outdatedTag}
                title="Parsed by an older version of the app — upload the file again to update it"
              >
                outdated
              </span>
            )
          )}
          <button
            className={styles.deleteBtn}
            onClick={(e) => handleDelete(d.id, e)}
            disabled={deleting}
            title="Delete from cache"
          >
            {deleting ? '…' : '✕'}
          </button>
        </div>
        );
      })}
    </div>
  );
};

export default DemoLibrary;
