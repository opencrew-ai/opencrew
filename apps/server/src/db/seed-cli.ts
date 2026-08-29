import { env } from '../env'
import { createDb } from './index'
import { seedIfEmpty, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } from './seed'
// Tools must register before seed validation references them.
import '../tools'

const { db } = createDb(env.dbPath)
const seeded = seedIfEmpty(db)
if (seeded) {
  console.log(`Seeded OpenCrew HQ. Admin login: ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD}`)
} else {
  console.log('Database already has users — nothing to seed.')
}
