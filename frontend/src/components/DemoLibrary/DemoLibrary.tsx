/**
 * DemoLibrary — lists previously parsed demos stored in the backend cache.
 * Allows loading a demo directly from the library or deleting it.
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
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    listDemos()
      .then((d) => setDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))))
      .catch(() => setDemos([]))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this demo from the cache?')) return;
    setDeleting(id);
    try {
      await deleteDemo(id);
      setDemos((prev) => prev.filter((d) => d.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <p className={styles.hint}>Loading library…</p>;
  if (demos.length === 0) return <p className={styles.hint}>No cached demos yet.</p>;

  return (
    <div className={styles.root}>
      {demos.map((d) => (
        <div
          key={d.id}
          className={styles.row}
          onClick={() => onLoad(d.id)}
          title={`Click to load ${d.filename}`}
        >
          <div className={styles.info}>
            <span className={styles.name}>{d.filename}</span>
            <span className={styles.meta}>
              {d.map_name} · {formatBytes(d.file_size)} · {d.tick_rate.toFixed(0)} tick
            </span>
          </div>
          <button
            className={styles.deleteBtn}
            onClick={(e) => handleDelete(d.id, e)}
            disabled={deleting === d.id}
            title="Delete from cache"
          >
            {deleting === d.id ? '…' : '✕'}
          </button>
        </div>
      ))}
    </div>
  );
};

export default DemoLibrary;
