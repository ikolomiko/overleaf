// @ts-check
import commandLineArgs from 'command-line-args'
import {
  setWriteMetrics,
  verifyProjectsInDateRange,
  verifyRandomProjectSample,
} from '../../backupVerifier/ProjectVerifier.mjs'
import knex from '../lib/knex.js'
import { client } from '../lib/mongodb.js'
import { setTimeout } from 'node:timers/promises'
import logger from '@overleaf/logger'
import { loadGlobalBlobs } from '../lib/blob_store/index.js'

logger.logger.level('fatal')

const usageMessage = [
  'Usage: node verify_sampled_projects.mjs [--startDate <start>] [--endDate <end>] [--nProjects <n>] [--verbose] [--usage] [--writeMetrics] [--concurrency <n>] [--strategy <range|random>]',
  'strategy: defaults to "range"; startDate and endDate are required for "range" strategy',
].join('\n')

/**
 * Gracefully shutdown the process
 * @param code
 * @return {Promise<void>}
 */
async function gracefulShutdown(code = process.exitCode) {
  await knex.destroy()
  await client.close()
  await setTimeout(1_000)
  process.exit(code)
}

const STATS = {
  verifiable: 0,
  unverifiable: 0,
}

/**
 * @typedef {Object} CLIOptions
 * @property {() => Promise<VerificationJobStatus>} projectVerifier
 * @property {boolean} verbose
 */

/**
 * @typedef {import('../../backupVerifier/types.d.ts').VerificationJobStatus} VerificationJobStatus
 */

/**
 *
 * @return {CLIOptions}
 */
function getOptions() {
  const {
    startDate,
    endDate,
    concurrency,
    writeMetrics,
    verbose,
    nProjects,
    strategy,
    usage,
  } = commandLineArgs([
    { name: 'startDate', type: String },
    { name: 'endDate', type: String },
    { name: 'concurrency', type: Number, defaultValue: 1 },
    { name: 'verbose', type: Boolean, defaultValue: false },
    { name: 'nProjects', type: Number, defaultValue: 10 },
    { name: 'usage', type: Boolean, defaultValue: false },
    { name: 'writeMetrics', type: Boolean, defaultValue: false },
    { name: 'strategy', type: String, defaultValue: 'range' },
  ])

  if (usage) {
    console.log(usageMessage)
    process.exit(0)
  }

  if (!['range', 'random'].includes(strategy)) {
    throw new Error(`Invalid strategy: ${strategy}`)
  }

  setWriteMetrics(writeMetrics)

  switch (strategy) {
    case 'random':
      console.log('Verifying random projects')
      return {
        verbose,
        projectVerifier: () => verifyRandomProjectSample(nProjects),
      }
    case 'range':
    default: {
      if (!startDate || !endDate) {
        throw new Error(usageMessage)
      }
      const start = Date.parse(startDate)
      const end = Date.parse(endDate)
      if (Number.isNaN(start)) {
        throw new Error(`Invalid start date: ${startDate}`)
      }

      if (Number.isNaN(end)) {
        throw new Error(`Invalid end date: ${endDate}`)
      }
      if (verbose) {
        console.log(`Verifying from ${startDate} to ${endDate}`)
        console.log(`Concurrency: ${concurrency}`)
      }
      STATS.ranges = 0
      return {
        projectVerifier: () =>
          verifyProjectsInDateRange({
            startDate: new Date(start),
            endDate: new Date(end),
            projectsPerRange: nProjects,
            concurrency,
          }),
        verbose,
      }
    }
  }
}

/**
 * @type {CLIOptions}
 */
let options
try {
  options = getOptions()
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await gracefulShutdown(1)
  process.exit() // just here so the type checker knows that the process will exit
}

const { projectVerifier, verbose } = options

if (verbose) {
  logger.logger.level('debug')
}

/**
 *
 * @param {Array<string>} array
 * @param {string} matchString
 * @return {*}
 */
function sumStringInstances(array, matchString) {
  return array.reduce((total, string) => {
    return string === matchString ? total + 1 : total
  }, 0)
}

/**
 *
 * @param {VerificationJobStatus} stats
 */
function displayStats(stats) {
  console.log(`Verified projects: ${stats.verified}`)
  console.log(`Total projects sampled: ${stats.total}`)
  if (stats.errorTypes.length > 0) {
    console.log('Errors:')
    for (const error of new Set(stats.errorTypes)) {
      console.log(`${error}: ${sumStringInstances(stats.errorTypes, error)}`)
    }
  }
}

await loadGlobalBlobs()

try {
  const stats = await projectVerifier()
  displayStats(stats)
  console.log(`completed`)
} catch (error) {
  console.error(error)
  console.log('completed with errors')
  process.exitCode = 1
} finally {
  console.log('shutting down')
  await gracefulShutdown()
}
