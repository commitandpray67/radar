import React from 'react';
import { useAppStore } from './store/demoStore';
import { useRoundPositions } from './hooks/useRoundPositions';
import DemoLoader from './components/DemoLoader/DemoLoader';
import AppLayout from './components/Layout/AppLayout';

const App: React.FC = () => {
  const demo = useAppStore((s) => s.demo);

  // Fetch positions for the active round whenever it changes.
  // This replaces the old "load all positions at once" approach.
  useRoundPositions();

  return (
    <>
      {!demo && <DemoLoader />}
      <AppLayout />
    </>
  );
};

export default App;
