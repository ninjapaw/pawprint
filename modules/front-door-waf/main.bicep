metadata description = 'HTTPS-only Front Door Premium routing, managed WAF, an optional benign correlation rule, and diagnostic logs. This module makes no claim about coverage of a particular CVE.'

import { pawprintTags } from '../types.bicep'

@description('Existing Premium Front Door profile.')
param profileName string

@description('Globally unique endpoint name.')
param endpointName string

@description('Alphanumeric WAF policy name.')
param policyName string

@description('Origin hostname, without scheme, port, or path.')
param originHostName string

@description('Workspace receiving access, health-probe, and WAF logs.')
param workspaceId string

@description('Start in Detection; change to Prevention only after validating logs and routing.')
@allowed(['Detection', 'Prevention'])
param wafMode string = 'Detection'

@description('Enable a training-only rule for the harmless dojoProbe=waf-marker query marker.')
param enableTrainingMarker bool = false

@description('Optional externally hosted custom subdomain. Empty preserves default-domain-only routing.')
@maxLength(253)
param customDomainName string = ''

@description('Associate the custom domain with HTTPS routing and WAF only after public DNS and Azure ownership validation succeed.')
param associateCustomDomain bool = false

@description('Front Door and WAF are global services.')
@allowed(['global'])
param location string = 'global'

@description('Pawprint ownership and expiry tags.')
param tags pawprintTags

resource profile 'Microsoft.Cdn/profiles@2025-04-15' existing = {
  name: profileName
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2025-04-15' = {
  parent: profile
  name: endpointName
  location: location
  tags: tags
  properties: {
    enabledState: 'Enabled'
  }
}

resource customDomain 'Microsoft.Cdn/profiles/customDomains@2025-04-15' = if (!empty(customDomainName)) {
  parent: profile
  name: 'application-domain'
  properties: {
    hostName: customDomainName
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
  }
}

var associatedCustomDomains = !empty(customDomainName) && associateCustomDomain ? [{ id: customDomain!.id }] : []

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2025-04-15' = {
  parent: profile
  name: 'application'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/health.php'
      probeRequestType: 'HEAD'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 120
    }
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2025-04-15' = {
  parent: originGroup
  name: 'application'
  properties: {
    hostName: originHostName
    originHostHeader: originHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2025-04-15' = {
  parent: endpoint
  name: 'application'
  properties: {
    originGroup: {
      id: originGroup.id
    }
    supportedProtocols: ['Https']
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
    enabledState: 'Enabled'
    customDomains: associatedCustomDomains
  }
  dependsOn: [origin, securityPolicy]
}

resource policy 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies@2025-03-01' = {
  name: policyName
  location: location
  tags: tags
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: wafMode
      requestBodyCheck: 'Enabled'
    }
    customRules: {
      rules: enableTrainingMarker ? [
        {
          name: 'DojoBenignMarker'
          priority: 10
          enabledState: 'Enabled'
          ruleType: 'MatchRule'
          action: 'Block'
          matchConditions: [
            {
              matchVariable: 'QueryString'
              operator: 'Contains'
              matchValue: ['dojoProbe=waf-marker']
              negateCondition: false
              transforms: []
            }
          ]
        }
      ] : []
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
          ruleSetAction: 'Block'
          ruleGroupOverrides: []
        }
      ]
    }
  }
}

resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2025-04-15' = {
  parent: profile
  name: 'application-waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: policy.id
      }
      associations: [
        {
          domains: concat([{ id: endpoint.id }], associatedCustomDomains)
          patternsToMatch: ['/*']
        }
      ]
    }
  }
}

// The latest stable API predates the diagnostic log schema used here.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'pawprint-evidence'
  scope: profile
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'FrontDoorAccessLog', enabled: true }
      { category: 'FrontDoorHealthProbeLog', enabled: true }
      { category: 'FrontDoorWebApplicationFirewallLog', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output endpointHostName string = endpoint.properties.hostName
output endpointId string = endpoint.id
output policyId string = policy.id
output customDomainId string = !empty(customDomainName) ? customDomain!.id : ''
