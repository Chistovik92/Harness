import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DshProvider } from '@/context/DshContext'
import { ChatProvider } from '@/context/ChatContext'
import { UpdateProvider } from '@/context/UpdateContext'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DshProvider>
      <ChatProvider>
        <UpdateProvider>
          <App />
        </UpdateProvider>
      </ChatProvider>
    </DshProvider>
  </React.StrictMode>
)
