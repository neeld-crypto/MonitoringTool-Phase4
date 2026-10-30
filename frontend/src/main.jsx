import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: the media engine must start exactly once.
createRoot(document.getElementById('root')).render(<App />);
