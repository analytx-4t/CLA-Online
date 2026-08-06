/**
 * Persistent system settings management for MentorVerse administration.
 * Manages runtime flags such as online evaluation metric calculation (Token Saver Toggle).
 */

let cachedEvaluationEnabled = null;

/**
 * Retrieves the current Online Evaluation toggle state (true = enabled, false = disabled/token saver).
 * @param {object} db - MongoDB database connection instance
 * @returns {Promise<boolean>}
 */
async function getEvaluationToggle(db) {
  if (cachedEvaluationEnabled !== null) {
    return cachedEvaluationEnabled;
  }

  if (!db) {
    return true; // Default to ON if DB is not provided
  }

  try {
    const settingsCollection = db.collection('system_settings');
    const doc = await settingsCollection.findOne({ key: 'online_evaluation_enabled' });

    if (doc && typeof doc.enabled === 'boolean') {
      cachedEvaluationEnabled = doc.enabled;
    } else {
      // Default to true and initialize setting document
      cachedEvaluationEnabled = true;
      await settingsCollection.updateOne(
        { key: 'online_evaluation_enabled' },
        { $set: { key: 'online_evaluation_enabled', enabled: true, updatedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error('[SettingsStore] Error loading online_evaluation_enabled:', error);
    if (cachedEvaluationEnabled === null) {
      cachedEvaluationEnabled = true;
    }
  }

  return cachedEvaluationEnabled;
}

/**
 * Persists the Online Evaluation toggle state in MongoDB and updates in-memory cache.
 * @param {object} db - MongoDB database connection instance
 * @param {boolean} enabled - New toggle state
 * @returns {Promise<boolean>}
 */
async function setEvaluationToggle(db, enabled) {
  const boolVal = Boolean(enabled);
  cachedEvaluationEnabled = boolVal;

  if (!db) {
    return boolVal;
  }

  try {
    const settingsCollection = db.collection('system_settings');
    await settingsCollection.updateOne(
      { key: 'online_evaluation_enabled' },
      { $set: { key: 'online_evaluation_enabled', enabled: boolVal, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`[SettingsStore] Online Evaluation toggle set to ${boolVal ? 'ENABLED (ON)' : 'DISABLED (OFF - Token Saver Active)'}`);
  } catch (error) {
    console.error('[SettingsStore] Error saving online_evaluation_enabled:', error);
  }

  return boolVal;
}

module.exports = {
  getEvaluationToggle,
  setEvaluationToggle,
};
