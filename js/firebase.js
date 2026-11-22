// Firebase-initialisatie. De config is niet geheim: de security rules beschermen de data.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyClb3qGSpQomOt-wFDx2Tyjslv1x0A-Tbg',
  authDomain: 'boodschappen-cce0d.firebaseapp.com',
  projectId: 'boodschappen-cce0d',
  storageBucket: 'boodschappen-cce0d.firebasestorage.app',
  messagingSenderId: '267448119336',
  appId: '1:267448119336:web:86c98ea3fb573a063b451d',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Lokale cache aan: overbrugt slecht bereik in de winkel, kost niets extra.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged };
