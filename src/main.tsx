import React from 'react'
import ReactDOM from 'react-dom/client'
import './design-system/tokens.css'
import './index.css'
import { AppProviders } from './app/providers'
import { AppRoutes } from './app/routes'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  </React.StrictMode>,
)
