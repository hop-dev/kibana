/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  HttpSetup,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/public';
import type { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import type { FeaturesPluginStart } from '@kbn/features-plugin/public';
import type { HomePublicPluginSetup } from '@kbn/home-plugin/public';
import { i18n } from '@kbn/i18n';
import type { LicensingPluginSetup } from '@kbn/licensing-plugin/public';
import type { ManagementSetup, ManagementStart } from '@kbn/management-plugin/public';
import type { SharePluginSetup, SharePluginStart } from '@kbn/share-plugin/public';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/public';

import type { UserProfile, UserProfileData, UserProfileWithSecurity } from '../common';
import type { SecurityLicense } from '../common/licensing';
import { SecurityLicenseService } from '../common/licensing';
import type { UserProfileBulkGetParams, UserProfileGetCurrentParams } from './account_management';
import { accountManagementApp, UserProfileAPIClient } from './account_management';
import { AnalyticsService } from './analytics';
import { AnonymousAccessService } from './anonymous_access';
import type { AuthenticationServiceSetup, AuthenticationServiceStart } from './authentication';
import { AuthenticationService } from './authentication';
import type { SecurityApiClients } from './components';
import type { ConfigType } from './config';
import { ManagementService, UserAPIClient } from './management';
import type { SecurityNavControlServiceStart } from './nav_control';
import { SecurityNavControlService } from './nav_control';
import { SecurityCheckupService } from './security_checkup';
import { SessionExpired, SessionTimeout, UnauthorizedResponseHttpInterceptor } from './session';
import type { UiApi } from './ui_api';
import { getUiApi } from './ui_api';

export interface PluginSetupDependencies {
  licensing: LicensingPluginSetup;
  home?: HomePublicPluginSetup;
  management?: ManagementSetup;
  share?: SharePluginSetup;
}

export interface PluginStartDependencies {
  features: FeaturesPluginStart;
  dataViews?: DataViewsPublicPluginStart;
  management?: ManagementStart;
  spaces?: SpacesPluginStart;
  share?: SharePluginStart;
}

export class SecurityPlugin
  implements
    Plugin<
      SecurityPluginSetup,
      SecurityPluginStart,
      PluginSetupDependencies,
      PluginStartDependencies
    >
{
  private readonly config: ConfigType;
  private sessionTimeout?: SessionTimeout;
  private readonly authenticationService = new AuthenticationService();
  private readonly navControlService = new SecurityNavControlService();
  private readonly securityLicenseService = new SecurityLicenseService();
  private readonly managementService = new ManagementService();
  private readonly securityCheckupService: SecurityCheckupService;
  private readonly anonymousAccessService = new AnonymousAccessService();
  private readonly analyticsService = new AnalyticsService();
  private authc!: AuthenticationServiceSetup;
  private securityApiClients!: SecurityApiClients;

  constructor(private readonly initializerContext: PluginInitializerContext) {
    this.config = this.initializerContext.config.get<ConfigType>();
    this.securityCheckupService = new SecurityCheckupService(this.config, localStorage);
  }

  public setup(
    core: CoreSetup<PluginStartDependencies>,
    { home, licensing, management, share }: PluginSetupDependencies
  ): SecurityPluginSetup {
    const { license } = this.securityLicenseService.setup({ license$: licensing.license$ });

    this.securityCheckupService.setup({ http: core.http });

    this.authc = this.authenticationService.setup({
      application: core.application,
      fatalErrors: core.fatalErrors,
      config: this.config,
      getStartServices: core.getStartServices,
      http: core.http,
    });

    this.securityApiClients = {
      userProfiles: new UserProfileAPIClient(core.http),
      users: new UserAPIClient(core.http),
    };

    this.navControlService.setup({
      securityLicense: license,
      logoutUrl: getLogoutUrl(core.http),
      securityApiClients: this.securityApiClients,
    });

    this.analyticsService.setup({ securityLicense: license });

    accountManagementApp.create({
      authc: this.authc,
      application: core.application,
      getStartServices: core.getStartServices,
      securityApiClients: this.securityApiClients,
    });

    if (management) {
      this.managementService.setup({
        license,
        management,
        authc: this.authc,
        fatalErrors: core.fatalErrors,
        getStartServices: core.getStartServices,
      });
    }

    if (management && home) {
      home.featureCatalogue.register({
        id: 'security',
        title: i18n.translate('xpack.security.registerFeature.securitySettingsTitle', {
          defaultMessage: 'Manage permissions',
        }),
        description: i18n.translate('xpack.security.registerFeature.securitySettingsDescription', {
          defaultMessage: 'Control who has access and what tasks they can perform.',
        }),
        icon: 'securityApp',
        path: '/app/management/security/roles',
        showOnHomePage: true,
        category: 'admin',
        order: 600,
      });
    }

    if (share) {
      this.anonymousAccessService.setup({ share });
    }

    return {
      authc: this.authc,
      license,
    };
  }

  public start(
    core: CoreStart,
    { management, share }: PluginStartDependencies
  ): SecurityPluginStart {
    const { application, http, notifications, docLinks } = core;
    const { anonymousPaths } = http;

    const logoutUrl = getLogoutUrl(http);
    const tenant = http.basePath.serverBasePath;

    const sessionExpired = new SessionExpired(application, logoutUrl, tenant);
    http.intercept(new UnauthorizedResponseHttpInterceptor(sessionExpired, anonymousPaths));
    this.sessionTimeout = new SessionTimeout(notifications, sessionExpired, http, tenant);

    this.sessionTimeout.start();
    this.securityCheckupService.start({ http, notifications, docLinks });

    if (management) {
      this.managementService.start({ capabilities: application.capabilities });
    }

    if (share) {
      this.anonymousAccessService.start({ http });
    }

    this.analyticsService.start({ http: core.http });

    return {
      uiApi: getUiApi({ core }),
      navControlService: this.navControlService.start({ core, authc: this.authc }),
      authc: this.authc as AuthenticationServiceStart,
      userProfiles: {
        getCurrent: this.securityApiClients.userProfiles.getCurrent.bind(
          this.securityApiClients.userProfiles
        ),
        bulkGet: this.securityApiClients.userProfiles.bulkGet.bind(
          this.securityApiClients.userProfiles
        ),
      },
    };
  }

  public stop() {
    this.sessionTimeout?.stop();
    this.navControlService.stop();
    this.securityLicenseService.stop();
    this.managementService.stop();
    this.analyticsService.stop();
  }
}

function getLogoutUrl(http: HttpSetup) {
  return `${http.basePath.serverBasePath}/logout`;
}

export interface SecurityPluginSetup {
  /**
   * Exposes authentication information about the currently logged in user.
   */
  authc: AuthenticationServiceSetup;
  /**
   * Exposes information about the available security features under the current license.
   */
  license: SecurityLicense;
}

export interface SecurityPluginStart {
  /**
   * Exposes the ability to add custom links to the dropdown menu in the top right, where the user's Avatar is.
   */
  navControlService: SecurityNavControlServiceStart;
  /**
   * Exposes authentication information about the currently logged in user.
   */
  authc: AuthenticationServiceStart;
  /**
   * A set of methods to work with Kibana user profiles.
   */
  userProfiles: {
    /**
     * Retrieves the user profile of the current user. If the profile isn't available, e.g. for the anonymous users or
     * users authenticated via authenticating proxies, the `null` value is returned.
     * @param [params] Get current user profile operation parameters.
     * @param params.dataPath By default `getCurrent()` returns user information, but does not return any user data. The
     * optional "dataPath" parameter can be used to return personal data for this user.
     */
    getCurrent<D extends UserProfileData>(
      params?: UserProfileGetCurrentParams
    ): Promise<UserProfileWithSecurity<D> | null>;
    /**
     * Retrieves multiple user profiles by their identifiers.
     * @param params Bulk get operation parameters.
     * @param params.uids List of user profile identifiers.
     * @param params.dataPath By default Elasticsearch returns user information, but does not return any user data. The
     * optional "dataPath" parameter can be used to return personal data for the requested user profiles.
     */
    bulkGet<D extends UserProfileData>(
      params: UserProfileBulkGetParams
    ): Promise<Array<UserProfile<D>>>;
  };

  /**
   * Exposes UI components that will be loaded asynchronously.
   * @deprecated
   */
  uiApi: UiApi;
}
