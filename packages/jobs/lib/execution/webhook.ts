import tracer from 'dd-trace';

import db from '@nangohq/database';
import { logContextGetter } from '@nangohq/logs';
import {
    NangoError,
    SyncJobsType,
    SyncStatus,
    configService,
    createSyncJob,
    environmentService,
    externalWebhookService,
    getApiUrl,
    getEndUserByConnectionId,
    getSync,
    getSyncConfigRaw,
    updateSyncJobStatus
} from '@nangohq/shared';
import { Err, Ok, metrics, tagTraceUser } from '@nangohq/utils';
import { sendSync as sendSyncWebhook } from '@nangohq/webhooks';

import { bigQueryClient } from '../clients.js';
import { startScript } from './operations/start.js';
import { getRunnerFlags } from '../utils/flags.js';
import { setTaskFailed, setTaskSuccess } from './operations/state.js';

import type { TaskWebhook } from '@nangohq/nango-orchestrator';
import type { Config, Job, Sync } from '@nangohq/shared';
import type { ConnectionJobs, DBEnvironment, DBSyncConfig, DBTeam, NangoProps } from '@nangohq/types';
import type { Result } from '@nangohq/utils';

export async function startWebhook(task: TaskWebhook): Promise<Result<void>> {
    let team: DBTeam | undefined;
    let environment: DBEnvironment | undefined;
    let providerConfig: Config | null = null;
    let sync: Sync | undefined | null;
    let syncJob: Pick<Job, 'id'> | null = null;
    let syncConfig: DBSyncConfig | null = null;
    let endUser: NangoProps['endUser'] | null = null;

    try {
        const accountAndEnv = await environmentService.getAccountAndEnvironment({ environmentId: task.connection.environment_id });
        if (!accountAndEnv) {
            throw new Error(`Account and environment not found`);
        }
        team = accountAndEnv.account;
        environment = accountAndEnv.environment;
        tagTraceUser(accountAndEnv);

        providerConfig = await configService.getProviderConfig(task.connection.provider_config_key, task.connection.environment_id);
        if (providerConfig === null) {
            throw new Error(`Provider config not found for connection: ${task.connection.connection_id}`);
        }

        sync = await getSync({ connectionId: task.connection.id, name: task.parentSyncName, variant: 'base' }); // webhooks are always executed against the 'base' sync
        if (!sync) {
            throw new Error(`Sync not found for connection: ${task.connection.connection_id}`);
        }

        syncConfig = await getSyncConfigRaw({
            environmentId: providerConfig.environment_id,
            config_id: providerConfig.id!,
            name: task.parentSyncName,
            isAction: false
        });
        if (!syncConfig) {
            throw new Error(`Webhook config not found: ${task.id}`);
        }
        if (!syncConfig.enabled) {
            throw new Error(`Webhook is disabled: ${task.id}`);
        }

        const getEndUser = await getEndUserByConnectionId(db.knex, { connectionId: task.connection.id });
        if (getEndUser.isOk()) {
            endUser = { id: getEndUser.value.id, endUserId: getEndUser.value.endUserId, orgId: getEndUser.value.organization?.organizationId || null };
        }

        const logCtx = logContextGetter.get({ id: String(task.activityLogId), accountId: team.id });

        void logCtx.info(`Starting webhook '${task.webhookName}'`, {
            input: task.input,
            webhook: task.webhookName,
            connection: task.connection.connection_id,
            integration: task.connection.provider_config_key
        });

        syncJob = await createSyncJob({
            sync_id: sync.id,
            type: SyncJobsType.INCREMENTAL,
            status: SyncStatus.RUNNING,
            job_id: task.name,
            nangoConnection: task.connection,
            sync_config_id: syncConfig.id,
            run_id: task.id,
            log_id: logCtx.id
        });
        if (!syncJob) {
            throw new Error(`Failed to create sync job for sync: ${sync.id}. TaskId: ${task.id}`);
        }

        const nangoProps: NangoProps = {
            scriptType: 'webhook',
            host: getApiUrl(),
            team: {
                id: team.id,
                name: team.name
            },
            connectionId: task.connection.connection_id,
            environmentId: task.connection.environment_id,
            environmentName: environment.name,
            providerConfigKey: task.connection.provider_config_key,
            provider: providerConfig.provider,
            activityLogId: logCtx.id,
            secretKey: environment.secret_key,
            nangoConnectionId: task.connection.id,
            attributes: syncConfig.attributes,
            syncConfig: syncConfig,
            syncId: sync.id,
            syncJobId: syncJob.id,
            debug: false,
            runnerFlags: await getRunnerFlags(),
            startedAt: new Date(),
            endUser,
            heartbeatTimeoutSecs: task.heartbeatTimeoutSecs
        };

        metrics.increment(metrics.Types.WEBHOOK_EXECUTION, 1, { accountId: team.id });

        const res = await startScript({
            taskId: task.id,
            nangoProps,
            logCtx: logCtx,
            input: task.input
        });

        if (res.isErr()) {
            throw res.error;
        }

        return Ok(undefined);
    } catch (err) {
        const error = new NangoError('webhook_script_failure', { error: err instanceof Error ? err.message : err });
        const syncJobId = syncJob?.id;
        if (syncJobId) {
            await updateSyncJobStatus(syncJobId, SyncStatus.STOPPED);
        }
        await onFailure({
            team,
            environment,
            connection: {
                id: task.connection.id,
                connection_id: task.connection.connection_id,
                environment_id: task.connection.environment_id,
                provider_config_key: task.connection.provider_config_key
            },
            syncId: sync?.id as string,
            syncVariant: sync?.variant as string,
            syncName: task.parentSyncName,
            syncJobId,
            providerConfigKey: task.connection.provider_config_key,
            providerConfig,
            activityLogId: task.activityLogId,
            models: syncConfig?.models || [],
            runTime: 0,
            error,
            syncConfig,
            endUser,
            startedAt: new Date()
        });
        return Err(error);
    }
}

export async function handleWebhookSuccess({ taskId, nangoProps }: { taskId: string; nangoProps: NangoProps }): Promise<void> {
    const logCtx = logContextGetter.get({ id: nangoProps.activityLogId, accountId: nangoProps.team.id });

    const content = `The webhook "${nangoProps.syncConfig.sync_name}" has been run successfully.`;
    void bigQueryClient.insert({
        executionType: 'webhook',
        connectionId: nangoProps.connectionId,
        internalConnectionId: nangoProps.nangoConnectionId,
        accountId: nangoProps.team?.id,
        accountName: nangoProps.team?.name || 'unknown',
        scriptName: nangoProps.syncConfig.sync_name,
        scriptType: nangoProps.syncConfig.type,
        environmentId: nangoProps.environmentId,
        environmentName: nangoProps.environmentName || 'unknown',
        providerConfigKey: nangoProps.providerConfigKey,
        status: 'success',
        syncId: nangoProps.syncId!,
        syncVariant: nangoProps.syncVariant!,
        content,
        runTimeInSeconds: (new Date().getTime() - nangoProps.startedAt.getTime()) / 1000,
        createdAt: Date.now(),
        internalIntegrationId: nangoProps.syncConfig.nango_config_id,
        endUser: nangoProps.endUser
    });

    const syncJob = await updateSyncJobStatus(nangoProps.syncJobId!, SyncStatus.SUCCESS);
    await setTaskSuccess({ taskId, output: null });

    if (!syncJob) {
        throw new Error(`Failed to update sync job status to SUCCESS for sync job: ${nangoProps.syncJobId}`);
    }

    const providerConfig = await configService.getProviderConfig(nangoProps.providerConfigKey, nangoProps.environmentId);
    if (providerConfig === null) {
        throw new Error(`Provider config not found for connection: ${nangoProps.connectionId}`);
    }

    const webhookSettings = await externalWebhookService.get(nangoProps.environmentId);

    const accountAndEnv = await environmentService.getAccountAndEnvironment({ environmentId: nangoProps.environmentId });
    if (!accountAndEnv) {
        throw new Error(`Account and environment not found`);
    }
    const team = accountAndEnv.account;
    const environment = accountAndEnv.environment;

    if (environment) {
        for (const model of nangoProps.syncConfig.models || []) {
            const span = tracer.startSpan('jobs.webhook.webhook', {
                tags: {
                    environmentId: nangoProps.environmentId,
                    connectionId: nangoProps.connectionId,
                    syncId: nangoProps.syncId,
                    syncJobId: nangoProps.syncJobId,
                    syncSuccess: true,
                    model
                }
            });

            void tracer.scope().activate(span, async () => {
                try {
                    const res = await sendSyncWebhook({
                        account: team,
                        connection: {
                            id: nangoProps.nangoConnectionId,
                            connection_id: nangoProps.connectionId,
                            environment_id: nangoProps.environmentId,
                            provider_config_key: nangoProps.providerConfigKey
                        },
                        environment: environment,
                        webhookSettings,
                        syncConfig: nangoProps.syncConfig,
                        syncVariant: nangoProps.syncVariant || 'base',
                        providerConfig,
                        model,
                        now: nangoProps.startedAt,
                        success: true,
                        responseResults: syncJob.result?.[model] || { added: 0, updated: 0, deleted: 0 },
                        operation: 'WEBHOOK'
                    });

                    if (res.isErr()) {
                        throw new Error(`Failed to send webhook for webhook: ${nangoProps.syncConfig.sync_name}`);
                    }
                } catch (err) {
                    span?.setTag('error', err);
                } finally {
                    span.finish();
                }
            });
        }
    }

    await logCtx.success();

    metrics.increment(metrics.Types.WEBHOOK_SUCCESS);
    metrics.duration(metrics.Types.WEBHOOK_TRACK_RUNTIME, Date.now() - nangoProps.startedAt.getTime());
}

export async function handleWebhookError({ taskId, nangoProps, error }: { taskId: string; nangoProps: NangoProps; error: NangoError }): Promise<void> {
    let team: DBTeam | undefined;
    let environment: DBEnvironment | undefined;
    const accountAndEnv = await environmentService.getAccountAndEnvironment({ environmentId: nangoProps.environmentId });
    if (accountAndEnv) {
        team = accountAndEnv.account;
        environment = accountAndEnv.environment;
    }

    const providerConfig = await configService.getProviderConfig(nangoProps.providerConfigKey, nangoProps.environmentId);
    if (providerConfig === null) {
        throw new Error(`Provider config not found for connection: ${nangoProps.connectionId}`);
    }

    const syncJobId = nangoProps.syncJobId;
    if (syncJobId) {
        await updateSyncJobStatus(syncJobId, SyncStatus.STOPPED);
    }

    await setTaskFailed({ taskId, error });

    await onFailure({
        team,
        environment,
        connection: {
            id: nangoProps.nangoConnectionId,
            connection_id: nangoProps.connectionId,
            environment_id: nangoProps.environmentId,
            provider_config_key: nangoProps.providerConfigKey
        },
        syncId: nangoProps.syncId!,
        syncVariant: nangoProps.syncVariant!,
        syncName: nangoProps.syncConfig.sync_name,
        syncJobId,
        providerConfigKey: nangoProps.providerConfigKey,
        providerConfig,
        activityLogId: nangoProps.activityLogId,
        models: nangoProps.syncConfig.models || [],
        runTime: (new Date().getTime() - nangoProps.startedAt.getTime()) / 1000,
        error,
        syncConfig: nangoProps.syncConfig,
        endUser: nangoProps.endUser,
        startedAt: nangoProps.startedAt
    });
}

async function onFailure({
    connection,
    team,
    environment,
    syncId,
    syncVariant,
    syncName,
    syncJobId,
    syncConfig,
    providerConfig,
    activityLogId,
    providerConfigKey,
    models,
    runTime,
    error,
    endUser,
    startedAt
}: {
    connection: ConnectionJobs;
    team: DBTeam | undefined;
    environment: DBEnvironment | undefined;
    syncId: string;
    syncVariant: string;
    syncJobId?: number | undefined;
    syncName: string;
    syncConfig: DBSyncConfig | null;
    providerConfig: Config | null;
    providerConfigKey: string;
    models: string[];
    activityLogId?: string | undefined;
    runTime: number;
    error: NangoError;
    endUser: NangoProps['endUser'];
    startedAt: Date;
}): Promise<void> {
    const logCtx = activityLogId && team ? logContextGetter.get({ id: activityLogId, accountId: team.id }) : null;

    if (environment) {
        const webhookSettings = await externalWebhookService.get(environment.id);
        if (webhookSettings) {
            const span = tracer.startSpan('jobs.webhook.webhook', {
                tags: {
                    environmentId: environment.id,
                    connectionId: connection.id,
                    syncId: syncId,
                    syncJobId: syncJobId,
                    syncSuccess: false
                }
            });

            if (team && environment && syncConfig && providerConfig) {
                void tracer.scope().activate(span, async () => {
                    try {
                        const res = await sendSyncWebhook({
                            account: team,
                            environment,
                            connection: connection,
                            webhookSettings,
                            syncConfig,
                            syncVariant,
                            providerConfig,
                            model: models.join(','),
                            success: false,
                            error: {
                                type: 'script_error',
                                description: error.message
                            },
                            now: new Date(),
                            operation: 'WEBHOOK'
                        });

                        if (res.isErr()) {
                            throw new Error(`Failed to send webhook for webhook: ${syncName}`);
                        }
                    } catch (err) {
                        span?.setTag('error', err);
                    } finally {
                        span.finish();
                    }
                });
            }
        }
    }
    if (team && environment) {
        void bigQueryClient.insert({
            executionType: 'webhook',
            connectionId: connection.connection_id,
            internalConnectionId: connection.id,
            accountId: team.id,
            accountName: team.name,
            scriptName: syncName,
            syncVariant: syncVariant,
            scriptType: 'webhook',
            environmentId: environment.id,
            environmentName: environment.name,
            providerConfigKey: providerConfigKey,
            status: 'failed',
            syncId: syncId,
            content: error.message,
            runTimeInSeconds: runTime,
            createdAt: Date.now(),
            internalIntegrationId: syncConfig?.nango_config_id || null,
            endUser
        });
    }

    void logCtx?.error(error.message, { error });
    await logCtx?.enrichOperation({ error });
    await logCtx?.failed();

    metrics.increment(metrics.Types.WEBHOOK_FAILURE);
    metrics.duration(metrics.Types.WEBHOOK_TRACK_RUNTIME, Date.now() - startedAt.getTime());
}
