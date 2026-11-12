import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from './app.js';
import '@xyflow/react/dist/style.css';
import './style.css';
import './shiori.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少应用根节点');
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
