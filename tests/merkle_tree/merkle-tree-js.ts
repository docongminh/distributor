import * as anchor from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { MerkleTree } from "merkletreejs";

export class ConcurrentMerkleTree {
  private readonly _tree: MerkleTree;
  constructor(
    leaves: {
      account: anchor.web3.PublicKey;
      amountUnlocked: anchor.BN;
      amountLocked: anchor.BN;
    }[]
  ) {
    this._tree = new MerkleTree(
      leaves.map(({ account, amountUnlocked, amountLocked }, index) => {
        return ConcurrentMerkleTree.toNode(
          account,
          amountUnlocked,
          amountLocked
        );
      }),
      keccak_256
    );

    console.log("layers: ", this._tree.getLayers());
  }

  static toNode(
    account: anchor.web3.PublicKey,
    amountUnlocked: anchor.BN,
    amountLocked: anchor.BN
  ): Buffer {
    const buf = Buffer.concat([
      account.toBuffer(),
      new anchor.BN(amountUnlocked).toArrayLike(Buffer, "le", 8),
      new anchor.BN(amountLocked).toArrayLike(Buffer, "le", 8),
    ]);

    return Buffer.from(keccak_256(buf));
  }

  getRightMostLeaf(): { rightmostLeaf: PublicKey; rightmostIndex: number } {
    const leaves = this._tree.getLeaves();
    if (leaves.length === 0) {
      throw new Error("The Merkle tree has no leaves.");
    }

    // The rightmost leaf is the last element in the leaves array
    const rightmostIndex = leaves.length - 1;
    const rightmostLeaf = leaves[rightmostIndex];

    return {
      rightmostLeaf: new anchor.web3.PublicKey(rightmostLeaf),
      rightmostIndex,
    };
  }

  getRightMostLeafWithProof(): {
    rightmostLeaf: PublicKey;
    rightmostIndex: number;
    proof: anchor.web3.PublicKey[];
  } {
    const { rightmostLeaf, rightmostIndex } = this.getRightMostLeaf();
    const proof = this._tree
      .getProof(rightmostLeaf.toBuffer())
      .map((item) => new anchor.web3.PublicKey(item.data));

    return {
      rightmostLeaf,
      rightmostIndex,
      proof,
    };
  }

  getRoot(): anchor.web3.PublicKey {
    return new anchor.web3.PublicKey(this._tree.getRoot());
  }

  getRootBuffer(): Buffer {
    return this._tree.getRoot();
  }

  getCanopyNodes(canopyDepth: number) {
    const layers = this._tree.getLayers();
    return layers[layers.length - canopyDepth].map(
      (node) => new anchor.web3.PublicKey(node)
    );
  }

  getProof(
    account: anchor.web3.PublicKey,
    amountUnlocked: anchor.BN,
    amountLocked: anchor.BN
  ): PublicKey[] {
    return this._tree
      .getProof(
        ConcurrentMerkleTree.toNode(account, amountUnlocked, amountLocked)
      )
      .map((proofItem) => new anchor.web3.PublicKey(proofItem.data));
  }
}
