import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <p>Salary Calculator</p>
  </StrictMode>,
);
