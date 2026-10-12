declare module '@npmcli/arborist' {
  export type ArboristEdge = {
    name: string;
    spec: string;
    type: string;
    to: ArboristNode | null;
  };
  export type ArboristNode = {
    name: string;
    version?: string;
    location: string;
    dev: boolean;
    isLink: boolean;
    edgesOut: Map<string, ArboristEdge>;
    inventory: Map<string, ArboristNode>;
  };
  export class Arborist {
    constructor(options: { path: string });
    loadVirtual(): Promise<ArboristNode>;
  }
}
