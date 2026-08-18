#!/usr/bin/env node
import { join } from "node:path";
import {
  App,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

type PanoramaHostingStackProps = StackProps & {
  bucketName?: string;
  domainName?: string;
  certificateArn?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
};

type PanoramaBudgetStackProps = StackProps & {
  budgetEmail: string;
  budgetAmount: number;
};

class PanoramaBudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: PanoramaBudgetStackProps) {
    super(scope, id, props);

    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: "panorama360-monthly-cost",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: props.budgetAmount,
          unit: "USD",
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{
            address: props.budgetEmail,
            subscriptionType: "EMAIL",
          }],
        },
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "FORECASTED",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{
            address: props.budgetEmail,
            subscriptionType: "EMAIL",
          }],
        },
      ],
    });
  }
}

class PanoramaHostingStack extends Stack {
  constructor(scope: Construct, id: string, props: PanoramaHostingStackProps) {
    super(scope, id, props);

    if (Boolean(props.domainName) !== Boolean(props.certificateArn)) {
      throw new Error("domainName et certificateArn doivent être fournis ensemble.");
    }
    if (Boolean(props.hostedZoneId) !== Boolean(props.hostedZoneName)) {
      throw new Error("hostedZoneId et hostedZoneName doivent être fournis ensemble.");
    }

    const bucket = new s3.Bucket(this, "VisitsBucket", {
      bucketName: props.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      cors: [{
        allowedHeaders: ["*"],
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: ["*"],
        exposedHeaders: ["ETag"],
        maxAge: 900,
      }],
      lifecycleRules: [
        {
          id: "ExpireOldObjectVersions",
          noncurrentVersionExpiration: Duration.days(90),
        },
        {
          id: "ExpireAbandonedUploads",
          prefix: "uploads/",
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const visitsTable = new dynamodb.Table(this, "VisitsTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, "CreatorUserPool", {
      userPoolName: "panorama360-creators",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 10,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(3),
      },
      userVerification: {
        emailSubject: "Votre code Panorama 360",
        emailBody: "Votre code de confirmation Panorama 360 est {####}",
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const userPoolClient = userPool.addClient("CreatorWebClient", {
      generateSecret: false,
      disableOAuth: true,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(7),
      preventUserExistenceErrors: true,
    });

    const apiFunction = new nodejs.NodejsFunction(this, "ApiFunction", {
      entry: join(import.meta.dirname, "functions", "api.ts"),
      depsLockFilePath: join(import.meta.dirname, "..", "package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
      },
      environment: {
        BUCKET_NAME: bucket.bucketName,
        TABLE_NAME: visitsTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });
    bucket.grantReadWrite(apiFunction);
    visitsTable.grantReadWriteData(apiFunction);

    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );
    const api = new apigwv2.HttpApi(this, "StudioApi", {
      apiName: "panorama360-studio",
      defaultAuthorizer: jwtAuthorizer,
      corsPreflight: {
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ["*"],
        maxAge: Duration.hours(1),
      },
    });
    const apiIntegration = new integrations.HttpLambdaIntegration("ApiIntegration", apiFunction);
    api.addRoutes({
      path: "/api/config",
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });
    api.addRoutes({
      path: "/api/visits",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/api/visits/{visitId}/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: "/api/visits/{visitId}/publish",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    const routeRewrite = new cloudfront.Function(this, "VisitRouteRewrite", {
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('/uploads/') === 0) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  if (request.uri === '/' || request.uri === '/studio' || request.uri === '/studio/') {
    request.uri = '/studio/v1/index.html';
  } else if (/^\\/studio\\/(?!v1\\/).+/.test(request.uri)) {
    request.uri = '/studio/v1/index.html';
  } else if (/^\\/v\\/[a-z0-9][a-z0-9-]*\\/?$/i.test(request.uri)) {
    request.uri = '/viewer/v1/index.html';
  }
  return request;
}`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Route le studio et les liens de visites, bloque les imports temporaires",
    });

    const cachePolicy = new cloudfront.CachePolicy(this, "OriginCacheHeaders", {
      comment: "Respecte les Cache-Control des releases et du pointeur current.json",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;
    const apiDomain = Fn.select(2, Fn.split("/", api.apiEndpoint));
    const distribution = new cloudfront.Distribution(this, "VisitsDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy,
        compress: true,
        responseHeadersPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: routeRewrite,
        }],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(apiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      minimumProtocolVersion: certificate
        ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
        : undefined,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: "Studio et hébergement privé des visites panoramiques 360°",
    });

    if (props.domainName && props.hostedZoneId && props.hostedZoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      new route53.ARecord(this, "AliasRecord", {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
      new route53.AaaaRecord(this, "AliasRecordIpv6", {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
    new CfnOutput(this, "ApiEndpoint", { value: api.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "BaseUrl", {
      value: props.domainName
        ? `https://${props.domainName}`
        : `https://${distribution.distributionDomainName}`,
    });
  }
}

const app = new App();
const budgetAmountContext = Number(app.node.tryGetContext("budgetAmount") ?? 50);
if (!Number.isFinite(budgetAmountContext) || budgetAmountContext <= 0) {
  throw new Error("budgetAmount doit être un montant positif.");
}
new PanoramaHostingStack(app, "Panorama360Hosting", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext("region") ?? process.env.AWS_REGION ?? "eu-central-2",
  },
  bucketName: app.node.tryGetContext("bucketName"),
  domainName: app.node.tryGetContext("domainName"),
  certificateArn: app.node.tryGetContext("certificateArn"),
  hostedZoneId: app.node.tryGetContext("hostedZoneId"),
  hostedZoneName: app.node.tryGetContext("hostedZoneName"),
});

const budgetEmailContext = app.node.tryGetContext("budgetEmail");
if (budgetEmailContext) {
  new PanoramaBudgetStack(app, "Panorama360Budget", {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: "us-east-1",
    },
    budgetEmail: budgetEmailContext,
    budgetAmount: budgetAmountContext,
  });
}
