// StockSync — Azure infrastructure (resource-group scope).
//
// Phase 1 (deployApp=false): registry, identity, Key Vault, PostgreSQL, Storage, monitoring, Container Apps environment.
// Phase 2 (deployApp=true):  the Container App, once CI has pushed the first image to the registry.
// See docs/DEPLOYMENT_GUIDE.md.

targetScope = 'resourceGroup'

@description('Short lowercase prefix for resource names.')
@minLength(3)
@maxLength(12)
param prefix string = 'stocksync'

param location string = resourceGroup().location

@description('Create the Container App (requires the image to exist in the registry).')
param deployApp bool = false

@description('Image tag in the registry, e.g. "stocksync:<git-sha>".')
param imageTag string = 'stocksync:latest'

@description('PostgreSQL administrator login.')
param postgresAdminLogin string = 'stocksyncadmin'

@secure()
@minLength(12)
@description('PostgreSQL administrator password.')
param postgresAdminPassword string

@secure()
@minLength(32)
@description('JWT signing secret (>= 32 chars).')
param jwtSecret string

@description('Email of the first admin user (created on first start).')
param adminEmail string

@secure()
@minLength(8)
@description('Initial password of the first admin user. Change it after first login.')
param adminPassword string

@description('WhatsApp Cloud API phone number id (not secret). Leave empty to disable WhatsApp.')
param whatsappPhoneNumberId string = ''

@secure()
@description('Optional channel and payment secrets, keys are env var names: META_APP_SECRET, META_VERIFY_TOKEN, WHATSAPP_TOKEN, MESSENGER_PAGE_TOKEN, INSTAGRAM_PAGE_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET. All are stored in Key Vault.')
param channelSecrets object = {}

var suffix = uniqueString(resourceGroup().id, prefix)
var appName = '${prefix}-app'
var imageContainer = 'product-images'
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var allowedChannelKeys = [
  'META_APP_SECRET'
  'META_VERIFY_TOKEN'
  'WHATSAPP_TOKEN'
  'MESSENGER_PAGE_TOKEN'
  'INSTAGRAM_PAGE_TOKEN'
  'TELEGRAM_BOT_TOKEN'
  'TELEGRAM_WEBHOOK_SECRET'
  'RAZORPAY_KEY_ID'
  'RAZORPAY_KEY_SECRET'
  'RAZORPAY_WEBHOOK_SECRET'
]
var channelKeys = filter(objectKeys(channelSecrets), k => contains(allowedChannelKeys, k) && !empty(channelSecrets[k]))

// ---------------- Monitoring ----------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ---------------- Identity & registry ----------------
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id-${suffix}'
  location: location
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('acr${prefix}${suffix}', 50)
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, roleAcrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------- PostgreSQL Flexible Server ----------------
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'inventory'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// 0.0.0.0 rule = "allow Azure services" (Container Apps egress). Use VNet integration for private networking.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// ---------------- Container Apps environment ----------------
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env-${suffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var publicUrl = 'https://${appName}.${env.properties.defaultDomain}'

// ---------------- Blob Storage (product images) ----------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${prefix}${suffix}', 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: true // product images are public; uploads need a short-lived SAS
    allowSharedKeyAccess: true // required to sign SAS URLs with the account key
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: [publicUrl]
          allowedMethods: ['PUT', 'GET', 'HEAD', 'OPTIONS']
          allowedHeaders: ['*']
          exposedHeaders: ['*']
          maxAgeInSeconds: 3600
        }
      ]
    }
    deleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource imagesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: imageContainer
  properties: { publicAccess: 'Blob' }
}

// ---------------- Key Vault (all runtime secrets) ----------------
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv${prefix}${suffix}', 24)
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, roleKeyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=require'
  }
}

resource secretJwt 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'jwt-secret'
  properties: { value: jwtSecret }
}

resource secretAdmin 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'admin-password'
  properties: { value: adminPassword }
}

resource secretStorage 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'storage-connection-string'
  properties: {
    value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
  }
}

resource secretChannels 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for key in channelKeys: {
  parent: vault
  name: toLower(replace(key, '_', '-'))
  properties: { value: channelSecrets[key] }
}]

// ---------------- Container App ----------------
var coreSecrets = [
  { name: 'database-url', keyVaultUrl: secretDb.properties.secretUri, identity: identity.id }
  { name: 'jwt-secret', keyVaultUrl: secretJwt.properties.secretUri, identity: identity.id }
  { name: 'admin-password', keyVaultUrl: secretAdmin.properties.secretUri, identity: identity.id }
  { name: 'storage-connection-string', keyVaultUrl: secretStorage.properties.secretUri, identity: identity.id }
]
var channelAppSecrets = [for key in channelKeys: {
  name: toLower(replace(key, '_', '-'))
  keyVaultUrl: 'https://${vault.name}${environment().suffixes.keyvaultDns}/secrets/${toLower(replace(key, '_', '-'))}'
  identity: identity.id
}]
var channelEnv = [for key in channelKeys: { name: key, secretRef: toLower(replace(key, '_', '-')) }]
var coreEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'PORT', value: '8080' }
  { name: 'PUBLIC_BASE_URL', value: publicUrl }
  { name: 'DATABASE_SSL', value: 'true' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
  { name: 'ADMIN_EMAIL', value: adminEmail }
  { name: 'ADMIN_PASSWORD', secretRef: 'admin-password' }
  { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
  { name: 'AZURE_STORAGE_CONTAINER', value: imageContainer }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
  { name: 'WHATSAPP_PHONE_NUMBER_ID', value: whatsappPhoneNumberId }
]

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [acrPull, kvSecretsUser, secretChannels]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: concat(coreSecrets, channelAppSecrets)
    }
    template: {
      containers: [
        {
          name: 'stocksync'
          image: '${acr.properties.loginServer}/${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(coreEnv, channelEnv)
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 5, failureThreshold: 24 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10, failureThreshold: 3 }
          ]
        }
      ]
      // Single replica: the realtime (SSE) event bus is in-process. Add Azure Web PubSub before scaling out.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output appUrl string = publicUrl
output containerAppName string = appName
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output keyVaultName string = vault.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
