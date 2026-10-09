import { Pool } from "pg";

// CI's disposable PostgreSQL service owns these two fixed test databases.
if (
  !process.env.CI ||
  !process.env.ASKR_ORM_TEST_DATABASE_URL ||
  !process.env.ASKR_ORM_TEST_SHADOW_URL
)
  throw new Error("Scratch database provisioning is restricted to the disposable CI service.");
const target = new URL(process.env.ASKR_ORM_TEST_DATABASE_URL);
const shadow = new URL(process.env.ASKR_ORM_TEST_SHADOW_URL);
if (
  target.hostname !== "127.0.0.1" ||
  target.pathname !== "/askr_orm_test" ||
  shadow.hostname !== "127.0.0.1" ||
  shadow.pathname !== "/askr_orm_test_shadow"
)
  throw new Error("Provisioning requires the fixed loopback CI test databases.");
const pool = new Pool({ connectionString: process.env.ASKR_ORM_TEST_DATABASE_URL });
try {
  await pool.query('CREATE DATABASE "askr_orm_test_shadow"');
} finally {
  await pool.end();
}
