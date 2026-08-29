import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { LandingPage } from './LandingPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>
)
