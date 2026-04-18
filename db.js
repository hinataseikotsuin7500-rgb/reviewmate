const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], usage: {} }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function findUserByEmail(email) {
  const db = loadDB();
  return db.users.find(u => u.email === email) || null;
}

function findUserById(id) {
  const db = loadDB();
  return db.users.find(u => u.id === id) || null;
}

function createUser(user) {
  const db = loadDB();
  db.users.push(user);
  saveDB(db);
  return user;
}

function updateUser(id, updates) {
  const db = loadDB();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  db.users[idx] = { ...db.users[idx], ...updates };
  saveDB(db);
  return db.users[idx];
}

function getMonthlyUsage(userId) {
  const db = loadDB();
  const key = `${userId}:${new Date().toISOString().slice(0, 7)}`;
  return db.usage[key] || 0;
}

function incrementUsage(userId) {
  const db = loadDB();
  const key = `${userId}:${new Date().toISOString().slice(0, 7)}`;
  db.usage[key] = (db.usage[key] || 0) + 1;
  saveDB(db);
  return db.usage[key];
}

module.exports = { findUserByEmail, findUserById, createUser, updateUser, getMonthlyUsage, incrementUsage };
