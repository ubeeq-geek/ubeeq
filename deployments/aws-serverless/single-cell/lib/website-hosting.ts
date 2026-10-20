import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
/** Neutral standard-distribution topology; consuming deployments own DNS, IAM and publisher composition. */
export class WebsiteHosting extends Construct {
  readonly bucket:s3.Bucket;readonly mappings:cloudfront.KeyValueStore;readonly distribution:cloudfront.Distribution;
  constructor(scope:Construct,id:string,props:{routerSource:(kvsArn:string)=>string;embeddingResponseSource?:(kvsArn:string)=>string;domainNames?:string[];certificate?:ICertificate}){
    super(scope,id);
    this.bucket=new s3.Bucket(this,'PublicReleaseBytes',{blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,encryption:s3.BucketEncryption.S3_MANAGED,versioned:true,removalPolicy:RemovalPolicy.RETAIN});
    this.mappings=new cloudfront.KeyValueStore(this,'ServingMappings');
    const router=new cloudfront.Function(this,'Router',{runtime:cloudfront.FunctionRuntime.JS_2_0,keyValueStore:this.mappings,code:cloudfront.FunctionCode.fromInline(props.routerSource(this.mappings.keyValueStoreArn))});
    const embedding=props.embeddingResponseSource?new cloudfront.Function(this,'EmbeddingPolicy',{runtime:cloudfront.FunctionRuntime.JS_2_0,keyValueStore:this.mappings,code:cloudfront.FunctionCode.fromInline(props.embeddingResponseSource(this.mappings.keyValueStoreArn))}):undefined;
    const logs=new s3.Bucket(this,'AccessLogs',{blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,objectOwnership:s3.ObjectOwnership.OBJECT_WRITER,enforceSSL:true,encryption:s3.BucketEncryption.S3_MANAGED,removalPolicy:RemovalPolicy.RETAIN,lifecycleRules:[{expiration:Duration.days(30)}]});
    this.distribution=new cloudfront.Distribution(this,'Distribution',{enableLogging:true,logBucket:logs,logFilePrefix:'website-requests/',domainNames:props.domainNames,certificate:props.certificate,defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(this.bucket),viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,allowedMethods:cloudfront.AllowedMethods.ALLOW_GET_HEAD,cachePolicy:cloudfront.CachePolicy.CACHING_OPTIMIZED,functionAssociations:[{function:router,eventType:cloudfront.FunctionEventType.VIEWER_REQUEST},...(embedding?[{function:embedding,eventType:cloudfront.FunctionEventType.VIEWER_RESPONSE}]:[])]},errorResponses:[{httpStatus:403,ttl:Duration.seconds(0)}]});
  }
}
