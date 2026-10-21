import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({root:'apps/web',plugins:[react()],build:{outDir:'../../dist/web',emptyOutDir:true},server:{port:52331,proxy:{'/api':'http://localhost:52330'}}});
