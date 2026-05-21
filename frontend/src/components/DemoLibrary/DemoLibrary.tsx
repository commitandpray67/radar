/**
 * DemoLibrary — lists previously parsed demos stored in the backend cache.
 * Supports loading, single delete, and bulk delete via checkboxes.
 */

import React, { useEffect, useState } from 'react';
import { listDemos, deleteDemo } from '../../utils/api';
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
    try {
      await Promise.all(Array.from(selected).map((id) => deleteDemo(id)));
      const removed = selected;
      setDemos((prev) => prev.filter((d) => !removed.has(d.id)));
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
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
      {demos.map((d) => (
        <div
          key={d.id}
          className={`${styles.row} ${selected.has(d.id) ? styles.rowSelected : ''}`}
          onClick={() => onLoad(d.id)}
          title={`Click to load ${d.filename}`}
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
          </div>
          <button
            className={styles.deleteBtn}
            onClick={(e) => handleDelete(d.id, e)}
            disabled={deleting}
            title="Delete from cache"
          >
            {deleting ? '…' : '✕'}
          </button>
        </div>
      ))}
    </div>
  );
};

export default DemoLibrary;
