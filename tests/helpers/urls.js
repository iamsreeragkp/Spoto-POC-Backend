// Connection strings for the isolated test database (same server as DATABASE_URL, database TEST_DATABASE_NAME).
function testUrls() {
  const mainUrl = process.env.MAIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sporto_poc';
  const dbName = process.env.TEST_DATABASE_NAME || 'sporto_poc_test';
  const u = new URL(mainUrl);
  const at = (db, user, pass) => {
    const x = new URL(u.href);
    x.pathname = `/${db}`;
    if (user) { x.username = user; x.password = pass; }
    return x.href;
  };
  return {
    mainUrl,
    dbName,
    testUrl: at(dbName),
    chatUrl: at(dbName, 'chat_reader', 'chat_reader'),
    adminUrl: at('postgres'),
  };
}

module.exports = { testUrls };
