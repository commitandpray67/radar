import React from 'react';
import { useAppStore } from './store/demoStore';
import DemoLoader from './components/DemoLoader/DemoLoader';
import AppLayout from './components/Layout/AppLayout';

const App: React.FC = () => {
  // Show the loader until a demo is fully loaded (demo != null)
  const demo = useAppStore((s) => s.demo);
  return (
    <>
      {!demo && <DemoLoader />}
      {/* Always mount AppLayout so canvas is ready; it renders empty state without demo */}
      <AppLayout />
    </>
  );
};

export default App;
